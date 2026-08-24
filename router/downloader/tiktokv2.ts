import axios from "axios";
import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import fs from "fs";

class TikTokScraper {
  private genericUserAgent: string;
  private debug: boolean;

  constructor(debug: boolean = false) {
    this.genericUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
    this.debug = debug;
  }

  private log(message: string, data?: any) {
    if (this.debug) {
      console.log(`[DEBUG] ${message}`, data ? data : '');
    }
  }

  private async shortener(url: string): Promise<string> {
    return url;
  }

  private decodeJWT(token: string): any {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload);
    } catch (error) {
      this.log("JWT decode error:", error);
      return null;
    }
  }

  private async getInitialCookies() {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));
    
    const headers = {
      "User-Agent": this.genericUserAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": '"Chromium";v="124", "Not A(Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"'
    };

    await client.get("https://www.tiktok.com/", { headers });
    return { jar, client, headers };
  }

  async getDownloadLinksTiktokio(URL: string) {
  try {
    this.log("Fetching download links from tiktokio.com for:", URL);

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    const commonHeaders = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
    };

    // GET awal (opsional, tapi dipertahankan buat jaga-jaga kalau Cloudflare
    // sewaktu-waktu aktifkan challenge di endpoint ini)
    await client.get("https://tiktokio.com/id/", { headers: commonHeaders });

    const response = await client.post(
      "https://tiktokio.com/api/v1/tk/html",
      { vid: URL, prefix: "tiktokio.com" },
      {
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          "Accept": "*/*",
          "Origin": "https://tiktokio.com",
          "Referer": "https://tiktokio.com/id/",
        },
      }
    );

    const $ = cheerio.load(response.data);

    const title = $(".tk-result-content .video-info h3").text().trim();
    const thumbnail = $(".tk-result-content .video-info img").attr("src") || "";

    const result: {
      title: string;
      thumbnail: string;
      video: { label: string; url: string }[];
      audio: string | null;
    } = {
      title,
      thumbnail,
      video: [],
      audio: null,
    };

    $(".tk-result-content .download-links a").each((i, el) => {
      const href = $(el).attr("href");
      const cls = $(el).attr("class") || "";
      const label = $(el).text().trim();
      if (!href) return;

      if (cls.includes("download-btn-purple")) {
        result.audio = href;
      } else {
        result.video.push({ label, url: href });
      }
    });

    this.log("Tiktokio result:", result);
    return result;
  } catch (err: any) {
    this.log("Error in getDownloadLinksTiktokio:", err.message);
    throw err;
  }
}

  async scrape(input: string) {
    try {
      this.log("Starting scrape for URL:", input);
      
      const { client, headers } = await this.getInitialCookies();
      this.log("Initial cookies obtained");

      const first = await client.get(input, { 
        headers, 
        maxRedirects: 0, 
        validateStatus: (s: number) => s >= 200 && s < 400 
      });
      
      let redirectUrl = first.headers.location || input;
      this.log("Initial redirect URL:", redirectUrl);

      if (redirectUrl.includes("/photo/")) {
        redirectUrl = redirectUrl.replace("/photo/", "/video/");
        this.log("Modified redirect URL:", redirectUrl);
      }

      const { data: html } = await client.get(redirectUrl, { headers, maxRedirects: 10 });
      this.log("HTML content received");

      if (!html.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
        this.log("Universal data not found in HTML");
        return { error: "content.data_not_found" };
      }

      const json = html.split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1].split("</script>")[0];
      const data = JSON.parse(json);
      this.log("Parsed JSON data:", data);

      const videoDetail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"];
      
      if (!videoDetail) {
        this.log("Video detail not found");
        return { error: "content.detail_not_found" };
      }

      if (videoDetail.statusMsg) {
        this.log("Video unavailable:", videoDetail.statusMsg);
        return { error: "content.post.unavailable" };
      }

      const item = videoDetail.itemInfo.itemStruct;
      const postId = item.id || "";
      this.log("Post ID:", postId);

      const downloadLinks = await this.getDownloadLinksTiktokio(input);
      this.log("Download links obtained:", downloadLinks);

      const result = {
        metadata: {
          stats: {
            likeCount: item.stats.diggCount,
            playCount: item.stats.playCount,
            commentCount: item.stats.commentCount,
            shareCount: item.stats.shareCount,
          },
          title: item.imagePost?.title || "",
          description: item.desc,
          hashtags: item.textExtra.filter((extra: any) => extra.type === 1).map((extra: any) => extra.hashtagName),
          locationCreated: item.locationCreated,
          suggestedWords: item.suggestedWords,
        },
        download: downloadLinks,
      };

      this.log("Final result:", result);
      
      return {
        success: true,
        data: result,
        postId: postId,
      };
    } catch (error: any) {
      this.log("Error in scrape:", error.message);
      return { error: "fetch.fail", message: error.message };
    }
  }
}

async function scrapeTiktokV2(url: string) {
  try {
    const scraper = new TikTokScraper()
    return await scraper.scrape(url)
  } catch (error: any) {
    console.error("Tiktok v2 scrape error:", error)
    return { error: "Failed to scrape TikTok data", message: error.message }
  }
}

export default [
  {
    metode: "GET",
    endpoint: "/api/d/tiktok/v2",
    name: "tiktok v2",
    category: "Downloader",
    description: "This API endpoint allows you to download TikTok videos and photos by providing a TikTok URL. It scrapes the necessary information from the TikTok page, including video/photo metadata and direct download links. This can be used for archival purposes, content analysis, or integrating TikTok content into other applications. The API supports both video and image posts, providing respective download links. It handles redirects and extracts the post ID to ensure accurate data retrieval. The response includes detailed metadata like like count, play count, comment count, share count, title, description, hashtags, and location created, along with direct download URLs for the media.",
    tags: ["DOWNLOADER", "TIKTOK", "VIDEO", "PHOTO", "SOCIAL MEDIA"],
    example: "?url=https://vt.tiktok.com/ZSjXNEnbC/",
    parameters: [
      {
        name: "url",
        in: "query",
        required: true,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
        },
        description: "TikTok URL",
        example: "https://vt.tiktok.com/ZSjXNEnbC/",
      },
    ],
    isPremium: false,
    isMaintenance: false,
    isPublic: true,
    async run({ req }) {
      const { url } = req.query || {}

      if (!url) {
        return {
          status: false,
          error: "URL parameter is required",
          code: 400,
        }
      }

      if (typeof url !== "string" || url.trim().length === 0) {
        return {
          status: false,
          error: "URL must be a non-empty string",
          code: 400,
        }
      }

      try {
        const result = await scrapeTiktokV2(url.trim())

        if (result && "error" in result) {
          return {
            status: false,
            error: result.message || "Failed to scrape TikTok data",
            code: 500,
          }
        }

        return {
          status: true,
          data: result.data,
          timestamp: new Date().toISOString(),
        }
      } catch (error: any) {
        return {
          status: false,
          error: error.message || "Internal Server Error",
          code: 500,
        }
      }
    },
  },
  {
    metode: "POST",
    endpoint: "/api/d/tiktok/v2",
    name: "tiktok v2",
    category: "Downloader",
    description: "This API endpoint allows you to download TikTok videos and photos by providing a TikTok URL in the request body. It scrapes the necessary information from the TikTok page, including video/photo metadata and direct download links. This can be used for archival purposes, content analysis, or integrating TikTok content into other applications. The API supports both video and image posts, providing respective download links. It handles redirects and extracts the post ID to ensure accurate data retrieval. The response includes detailed metadata like like count, play count, comment count, share count, title, description, hashtags, and location created, along with direct download URLs for the media.",
    tags: ["DOWNLOADER", "TIKTOK", "VIDEO", "PHOTO", "SOCIAL MEDIA"],
    example: "",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["url"],
            properties: {
              url: {
                type: "string",
                description: "TikTok URL",
                example: "https://vt.tiktok.com/ZSjXNEnbC/",
                minLength: 1,
                maxLength: 1000,
              },
            },
            additionalProperties: false,
          },
        },
      },
    },
    isPremium: false,
    isMaintenance: false,
    isPublic: true,
    async run({ req }) {
      const { url } = req.body || {}

      if (!url) {
        return {
          status: false,
          error: "URL parameter is required",
          code: 400,
        }
      }

      if (typeof url !== "string" || url.trim().length === 0) {
        return {
          status: false,
          error: "URL must be a non-empty string",
          code: 400,
        }
      }

      try {
        const result = await scrapeTiktokV2(url.trim())

        if (result && "error" in result) {
          return {
            status: false,
            error: result.message || "Failed to scrape TikTok data",
            code: 500,
          }
        }

        return {
          status: true,
          data: result.data,
          timestamp: new Date().toISOString(),
        }
      } catch (error: any) {
        return {
          status: false,
          error: error.message || "Internal Server Error",
          code: 500,
        }
      }
    },
  },
]
