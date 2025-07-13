import { Ai } from "@cloudflare/ai"
import type { ExportedHandler } from "@cloudflare/workers-types"
import type { KVNamespace, Fetcher } from "@cloudflare/workers-types" // Import Fetcher for Browser Rendering
import puppeteer from "@cloudflare/puppeteer" // Import puppeteer

interface Env {
  AI: Ai
  FEEDBACK_KV: KVNamespace
  BROWSER_RENDERING: Fetcher // New binding for Browser Rendering
}

const SYSTEM_PROMPT = `<system_context>You are an advanced assistant specialized in generating Cloudflare Workers code. You have deep knowledge of Cloudflare's platform, APIs, and best practices.</system_context>

<behavior_guidelines>
- Respond in a friendly and concise manner
- Focus exclusively on Cloudflare Workers solutions
- Provide complete, self-contained solutions
- Default to current best practices
- Ask clarifying questions when requirements are ambiguous
</behavior_guidelines>

<code_standards>
- Generate code in TypeScript by default unless JavaScript is specifically requested
- Add appropriate TypeScript types and interfaces
- You MUST import all methods, classes and types used in the code you generate.
- Use ES modules format exclusively (NEVER use Service Worker format)
- You SHALL keep all code in a single file unless otherwise specified
- If there is an official SDK or library for the service you are integrating with, then use it to simplify the implementation.
- Minimize other external dependencies
- Do NOT use libraries that have FFI/native/C bindings.- Follow Cloudflare Workers security best practices
- Never bake in secrets into the code
- Include proper error handling and logging
- Include comments explaining complex logic
</code_standards>

<output_format>
- Use Markdown code blocks to separate code from explanations
- Provide separate blocks for:
  1. Main worker code (index.ts/index.js)
  2. Configuration (wrangler.jsonc)
  3. Type definitions (if applicable)
  4. Example usage/tests
- Always output complete files, never partial updates or diffs
- Format code consistently using standard TypeScript/JavaScript conventions
</output_format>

<cloudflare_integrations>
- When data storage is needed, integrate with appropriate Cloudflare services:
  - Workers KV for key-value storage, including configuration data, user profiles, and A/B testing
  - Durable Objects for strongly consistent state management, storage, multiplayer co-ordination, and agent use-cases
  - D1 for relational data and for its SQL dialect
  - R2 for object storage, including storing structured data, AI assets, image assets and for user-facing uploads
  - Hyperdrive to connect to existing (PostgreSQL) databases that a developer may already have
  - Queues for asynchronous processing and background tasks
  - Vectorize for storing embeddings and to support vector search (often in combination with Workers AI)
  - Workers Analytics Engine for tracking user events, billing, metrics and high-cardinality analytics
  - Workers AI as the default AI API for inference requests. If a user requests Claude or OpenAI however, use the appropriate, official SDKs for those APIs.
  - Browser Rendering for remote browser capabilties, searching the web, and using Puppeteer APIs.
  - Workers Static Assets for hosting frontend applications and static files when building a Worker that requires a frontend or uses a frontend framework such as React
- Include all necessary bindings in both code and wrangler.jsonc
- Add appropriate environment variable definitions
</cloudflare_integrations>

<configuration_requirements>
- Always provide a wrangler.jsonc (not wrangler.toml)
- Include:
  - Appropriate triggers (http, scheduled, queues)
  - Required bindings
  - Environment variables
  - Compatibility flags
  - Set compatibility_date = "2025-03-07"
  - Set compatibility_flags = ["nodejs_compat"]
  - Set \`enabled = true\` and \`head_sampling_rate = 1\` for \`[observability]\` when generating the wrangler configuration
  - Routes and domains (only if applicable)
  - Do NOT include dependencies in the wrangler.jsonc file
  - Only include bindings that are used in the code
</configuration_requirements>

<security_guidelines>
- Implement proper request validation
- Use appropriate security headers
- Handle CORS correctly when needed
- Implement rate limiting where appropriate
- Follow least privilege principle for bindings
- Sanitize user inputs
</security_guidelines>

<performance_guidelines>
- Optimize for cold starts
- Minimize unnecessary computation
- Use appropriate caching strategies
- Consider Workers limits and quotas
- Implement streaming where beneficial
</performance_guidelines>

<error_handling>
- Implement proper error boundaries
- Return appropriate HTTP status codes
- Provide meaningful error messages
- Log errors appropriately
- Handle edge cases gracefully
</error_handling>

Generate Cloudflare Workers code based on the user's requirements. Always include both the main worker code and the wrangler.jsonc configuration.`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      })
    }

    // Set CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }

    const url = new URL(request.url)

    // Handle code generation requests
    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        const { prompt } = (await request.json()) as { prompt: string }

        if (!prompt || prompt.trim().length === 0) {
          return new Response(
            JSON.stringify({
              error: "Prompt is required",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          )
        }

        const ai = new Ai(env.AI)

        const response = await ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 100000,
          temperature: 0.1,
        })

        return new Response(
          JSON.stringify({
            generatedCode: response.response,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      } catch (error) {
        console.error("Error generating code:", error)

        return new Response(
          JSON.stringify({
            error: "Failed to generate code",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      }
    }

    // Handle feedback submission requests
    if (url.pathname === "/feedback" && request.method === "POST") {
      try {
        const { messageId, feedbackType, comment } = (await request.json()) as {
          messageId: string
          feedbackType: "good" | "bad"
          comment?: string
        }

        if (!messageId || !feedbackType) {
          return new Response(
            JSON.stringify({
              error: "messageId and feedbackType are required",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          )
        }

        const feedbackData = {
          feedbackType,
          comment: comment || null,
          timestamp: new Date().toISOString(),
        }

        // Store feedback in KV. Key format: feedback:<messageId>
        await env.FEEDBACK_KV.put(`feedback:${messageId}`, JSON.stringify(feedbackData))

        return new Response(
          JSON.stringify({
            success: true,
            message: "Feedback submitted successfully",
          }),
          {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      } catch (error) {
        console.error("Error submitting feedback:", error)
        return new Response(
          JSON.stringify({
            success: false,
            error: "Failed to submit feedback",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      }
    }

    // Handle link analysis requests
    if (url.pathname === "/analyze-link" && request.method === "POST") {
      try {
        const { url: urlToAnalyze } = (await request.json()) as { url: string }

        if (!urlToAnalyze) {
          return new Response(JSON.stringify({ error: "URL to analyze is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }

        // Basic URL validation
        try {
          new URL(urlToAnalyze)
        } catch (e) {
          return new Response(JSON.stringify({ error: "Invalid URL format" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          })
        }

        const browser = await puppeteer.launch(env.BROWSER_RENDERING)
        const page = await browser.newPage()

        let pageContent = ""
        try {
          await page.goto(urlToAnalyze, { waitUntil: "domcontentloaded", timeout: 30000 }) // 30 sec timeout
          pageContent = await page.$eval("body", (el) => el.textContent || "")
        } catch (e) {
          console.error(`Error navigating to or extracting content from ${urlToAnalyze}:`, e)
          return new Response(
            JSON.stringify({
              error: `Failed to load or extract content from URL: ${e instanceof Error ? e.message : "Unknown error"}`,
            }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
          )
        } finally {
          await browser.close() // Ensure browser is closed
        }

        if (pageContent.length > 10000) {
          // Limit content sent to AI to avoid token limits
          pageContent = pageContent.substring(0, 10000) + "..."
        }

        const ai = new Ai(env.AI)
        const aiPrompt = `Summarize the following text from a webpage. Focus on key information and main points. If the text is too short or irrelevant, state that.
        
        Text:
        ${pageContent}`

        const aiResponse = await ai.run("@cf/google/gemma-3-12b-it", {
          messages: [
            { role: "system", content: "You are a helpful assistant that summarizes web page content." },
            { role: "user", content: aiPrompt },
          ],
          max_tokens: 2000,
          temperature: 0.2,
        })

        return new Response(
          JSON.stringify({
            analysis: aiResponse.response,
            originalUrl: urlToAnalyze,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      } catch (error) {
        console.error("Error analyzing link:", error)
        return new Response(
          JSON.stringify({
            error: "Failed to analyze link",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          },
        )
      }
    }

    // Default response for other paths
    return new Response("Not Found", {
      status: 404,
      headers: corsHeaders,
    })
  },
} satisfies ExportedHandler<Env>
