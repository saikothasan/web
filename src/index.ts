import { z } from "zod";
import puppeteer from "@cloudflare/puppeteer";
import zodToJsonSchema from "zod-to-json-schema";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname != "/") {
      return new Response("Not found");
    }

    // Your prompt and site to scrape
    const userPrompt = "Extract the first post only.";
    const targetUrl = "https://labs.apnic.net/";

    // Launch browser
    const browser = await puppeteer.launch(env.MY_BROWSER);
    const page = await browser.newPage();
    await page.goto(targetUrl);

    // Get website text
    const renderedText = await page.evaluate(() => {
      // @ts-ignore js code to run in the browser context
      const body = document.querySelector("body");
      return body ? body.innerText : "";
    });
    // Close browser since we no longer need it
    await browser.close();

    // define your desired json schema
    const outputSchema = zodToJsonSchema(
      z.object({ title: z.string(), url: z.string(), date: z.string() })
    );

    // Example prompt
    const prompt = `
    You are a sophisticated web scraper. You are given the user data extraction goal and the JSON schema for the output data format.
    Your task is to extract the requested information from the text and output it in the specified JSON schema format:

        ${JSON.stringify(outputSchema)}

    DO NOT include anything else besides the JSON output, no markdown, no plaintext, just JSON.

    User Data Extraction Goal: ${userPrompt}

    Text extracted from the webpage: ${renderedText}`;

    // call llm
    const result = await getLLMResult(env, prompt, outputSchema);
    return Response.json(result);
  }

} satisfies ExportedHandler<Env>;


async function getLLMResult(env, prompt: string, schema?: any) {
  const model = "@hf/thebloke/deepseek-coder-6.7b-instruct-awq"
  const requestBody = {
    messages: [{
      role: "user",
      content: prompt
    }],
  };
  const aiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run/${model}`

  const response = await fetch(aiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.API_TOKEN}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    console.log(JSON.stringify(await response.text(), null, 2));
    throw new Error(`LLM call failed ${aiUrl} ${response.status}`);
  }

  // process response
  const data = await response.json() as { result: { response: string }};
  const text = data.result.response || '';
  const value = (text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text])[1];
  try {
    return JSON.parse(value);
  } catch(e) {
    console.error(`${e} . Response: ${value}`)
  }
}
