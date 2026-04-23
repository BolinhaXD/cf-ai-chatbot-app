/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/api/history") {
			const { sessionId } = await request.json();
			const history =
				(await env.CHAT_KV.get(sessionId, { type: "json" })) || [];
			return Response.json({ history });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [], sessionId } = (await request.json()) as {
			messages: ChatMessage[];
			sessionId: string
		};

		if (!sessionId) {
			return new Response("Missing sessionId", { status: 400 });
		}
		console.log(sessionId)

		let history =
			(await env.CHAT_KV.get(sessionId, { type: "json" })) || [];

		if (history.length === 0) {
			history = messages;
		} else {
			// append ONLY the last user message
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "user") {
				history.push(lastMsg);
			}
		}

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages: history,
				max_tokens: 1024,
				stream: true,
			},
			{
				// Uncomment to use AI Gateway
				// gateway: {
				//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
				//   skipCache: false,      // Set to true to bypass cache
				//   cacheTtl: 3600,        // Cache time-to-live in seconds
				// },
			},
		);

		let fullResponse = "";

		const transformedStream = new ReadableStream({
			async start(controller) {
				const reader = stream.getReader();
				const decoder = new TextDecoder();
				const encoder = new TextEncoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value);
					fullResponse += chunk;

					controller.enqueue(encoder.encode(chunk));
				}

				history.push({
					role: "assistant",
					content: fullResponse,
				});

				await env.CHAT_KV.put(
					sessionId,
					JSON.stringify(history),
					{ expirationTtl: 86400 }
				);

				controller.close();
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
