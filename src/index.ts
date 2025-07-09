// src/index.ts

import puppeteer, { Page } from '@cloudflare/puppeteer';
import { z } from 'zod';

// Define the environment bindings for type safety
export interface Env {
	BROWSER: Fetcher;
	AI: Ai;
}

// --- Input Validation Schema using Zod ---
const RenderOptionsSchema = z.object({
	viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
	fullPage: z.boolean().optional().default(false),
	waitForSelector: z.string().optional(),
});

const RequestSchema = z
	.object({
		url: z.string().url({ message: 'A valid URL is required.' }),
		action: z.enum(['analyze_image', 'summarize_text', 'extract_html']),
		prompt: z.string().optional(),
		model: z
			.string()
			.optional()
			.default('@cf/llava-1.5-7b-hf'), // Default to LLaVA for image analysis
		renderOptions: RenderOptionsSchema.optional().default({}),
	})
	.refine((data) => !(data.action === 'analyze_image' && !data.prompt), {
		message: 'A `prompt` is required when `action` is `analyze_image`.',
		path: ['prompt'],
	});


/**
 * Helper function to launch a browser, navigate to a URL, and handle wait conditions.
 * This avoids code duplication across different actions.
 */
async function launchAndNavigate(env: Env, url: string, options: z.infer<typeof RenderOptionsSchema>): Promise<Page> {
	const browser = await puppeteer.launch(env.BROWSER);
	const page = await browser.newPage();
	if (options.viewport) {
		await page.setViewport(options.viewport);
	}
	await page.goto(url, { waitUntil: 'networkidle2' });
	if (options.waitForSelector) {
		await page.waitForSelector(options.waitForSelector, { timeout: 10000 }); // 10s timeout
	}
	return page;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed. Please use POST.', { status: 405 });
		}
		
		const startTime = Date.now();
		
		try {
			const body = await request.json();

			// --- 1. Validate Input ---
			const validationResult = RequestSchema.safeParse(body);
			if (!validationResult.success) {
				return Response.json(
					{ success: false, error: { message: 'Invalid request body.', details: validationResult.error.flatten() } },
					{ status: 400 }
				);
			}

			const { url, action, prompt, model, renderOptions } = validationResult.data;

			let data;
			let page: Page | null = null;

			// --- 2. Route to the Correct Action ---
			switch (action) {
				case 'analyze_image': {
					page = await launchAndNavigate(env, url, renderOptions);
					const screenshotBuffer = await page.screenshot({ fullPage: renderOptions.fullPage });
					
					const inputs = {
						prompt: prompt!, // Zod refinement ensures prompt exists
						image: [...new Uint8Array(screenshotBuffer)],
					};
					const aiResponse = await env.AI.run(model, inputs);
					data = { aiResponse: aiResponse.response };
					break;
				}

				case 'summarize_text': {
					page = await launchAndNavigate(env, url, renderOptions);
					const pageText = await page.evaluate(() => document.body.innerText);
					
					const summarizationPrompt = `Please provide a concise summary of the following text extracted from a webpage:\n\n---\n\n${pageText.substring(0, 8000)}`; // Limit text length
					const textModel = '@cf/meta/llama-2-7b-chat-int8'; // Use a text model for this
					
					const aiResponse = await env.AI.run(textModel, { prompt: summarizationPrompt });
					data = { aiResponse: aiResponse.response, modelUsed: textModel };
					break;
				}

				case 'extract_html': {
					page = await launchAndNavigate(env, url, renderOptions);
					const html = await page.content();
					data = { html };
					break;
				}
				
				default:
					// This case should not be reachable due to Zod validation
					return Response.json({ success: false, error: { message: 'Invalid action.' } }, { status: 400 });
			}

			// --- 3. Clean up and Respond ---
			if (page) {
				await page.browser().close();
			}
			
			const endTime = Date.now();

			return Response.json({
				success: true,
				data,
				metadata: {
					url,
					action,
					modelUsed: data.modelUsed || model,
					executionTimeMs: endTime - startTime
				}
			});

		} catch (e) {
			console.error('An error occurred:', e);
			const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
			return Response.json(
				{ success: false, error: { message: `An internal server error occurred: ${errorMessage}` } },
				{ status: 500 }
			);
		}
	},
};
