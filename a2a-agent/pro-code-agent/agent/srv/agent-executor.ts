import { v4 as uuidv4 } from "uuid";

// CAP
import cds from "@sap/cds";

// A2A
import { Task, TaskStatusUpdateEvent, Message } from "@a2a-js/sdk";
import { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

// LANGCHAIN / LANGGRAPH WITH GENERATIVE AI HUB, SAP AI CORE
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { END, START, Command, MemorySaver, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseMessageLike } from "@langchain/core/messages";

import { a2aMessagesToLangChain } from "./utils/a2aToLangchain";
import { tools as agentTools } from "./tools/tools";
import { loadMcpTools } from "./utils/mcp-loader";
import { getSystemPrompt } from "./utils/prompts";
import { createInterruptUpdate, createMessage, createMessageUpdate, createNewTask } from "./utils/a2a-operations";

const logger = cds.log("pro-code-agent", { label: "Pro-code Agent" });

const contexts = new Map<string, Message[]>();

type AgentGraphState = {
    messages: BaseMessageLike[];
};

function createAgentNode(modelWithTools: ReturnType<OrchestrationClient["bindTools"]>) {
    return async (state: AgentGraphState) => {
        const response = await modelWithTools.invoke([
            { role: "system", content: getSystemPrompt() },
            ...state.messages
        ]);
        return { messages: [response] };
    };
}

export class LangGraphAgentExecutor implements AgentExecutor {
    private app: any;
    // Resolved in init(); app is unusable until init() resolves
    private initPromise: Promise<void>;

    constructor() {
        this.initPromise = this.init();
    }

    private async init(): Promise<void> {
        const mcpTools = await loadMcpTools();
        const allTools = [...agentTools, ...mcpTools];

        const model = new OrchestrationClient({
            promptTemplating: {
                model: {
                    name: "gpt-5.4"
                }
            }
        });
        const modelWithTools = model.bindTools(allTools);
        const toolNode = new ToolNode(allTools);
        const stateGraph = this.instantiateStateGraph(toolNode, createAgentNode(modelWithTools));
        const memorySaver = new MemorySaver();
        this.app = stateGraph.compile({ checkpointer: memorySaver });
    }

    private instantiateStateGraph = (
        toolNode: ToolNode,
        agentNode: (state: AgentGraphState) => Promise<{ messages: unknown[] }>
    ) => {
        return new StateGraph(MessagesAnnotation)
            .addNode("agent", agentNode)
            .addNode("tools", toolNode)
            .addEdge(START, "agent")
            .addConditionalEdges("agent", this.shouldContinue, ["tools", END])
            .addEdge("tools", "agent")
    };

    

    private validateExtensions(extensions: string[] | undefined) {
        const knownExtensions = ["https://github.com/SAP-samples/btp-joule-a2a-pro-code-agent/a2a-agent/extensions/mock-response/v1"]
        const validExtensions = extensions?.filter((ext) => knownExtensions.includes(ext)) || [];

        return validExtensions;
    }

    private mockResponse(eventBus: ExecutionEventBus): void {
        eventBus.publish({
            kind: "message",
            role: "agent",
            messageId: uuidv4(),
            parts: [{ kind: "text", text: "This is a mocked response from the Sales Optimization Agent." }],
        })
    }


    private publishAndLog(eventBus: ExecutionEventBus, payload: unknown, label: string): void {
        logger.info(`[A2A-PUBLISH] ${label}:`, JSON.stringify(payload, null, 2));
        eventBus.publish(payload as Parameters<typeof eventBus.publish>[0]);
    }

    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
        await this.initPromise;
        logger.info("[A2A-EXECUTE] requestContext:", JSON.stringify(requestContext, null, 2));
        logger.info("[A2A-EXECUTE] userMessage.parts:", JSON.stringify(requestContext.userMessage.parts, null, 2));
        if (requestContext.task) {
            logger.info("[A2A-EXECUTE] task.status.message:", JSON.stringify(requestContext.task.status?.message, null, 2));
            logger.info("[A2A-EXECUTE] task.history:", JSON.stringify(requestContext.task.history, null, 2));
        }

        const extensions = this.validateExtensions(requestContext.userMessage.extensions);
        logger.info("[A2A-EXECUTE] validated extensions:", extensions);

        if(extensions.includes("https://github.com/SAP-samples/btp-joule-a2a-pro-code-agent/a2a-agent/extensions/mock-response/v1")) {
            logger.info("[A2A-EXECUTE] mock-response extension active — returning mock payload");
            this.mockResponse(eventBus)
            return
        }

        const userMessage = requestContext.userMessage;
        const existingTask = requestContext.task;

        if(userMessage.parts.find((part) => part.kind !== "text")) {
            logger.warn("[A2A-EXECUTE] non-text parts found (only text is supported):", JSON.stringify(userMessage.parts, null, 2));
        }

        const taskId = existingTask?.id || requestContext.taskId || uuidv4();
        const contextId = userMessage.contextId || existingTask?.contextId || uuidv4();
        logger.info(`[A2A-EXECUTE] taskId=${taskId} contextId=${contextId} existingTask=${!!existingTask}`);

        // 1. Publish initial Task event if it's a new task
        if (!existingTask) {
            const initialTask: Task = createNewTask(userMessage, {taskId, contextId})
            this.publishAndLog(eventBus, initialTask, "initial Task event");
        }

        // 2. Publish "working" status update
        const workingStatusUpdate: TaskStatusUpdateEvent = createMessageUpdate("Processing your request...", {taskId, contextId, final: false});
        this.publishAndLog(eventBus, workingStatusUpdate, "working status update");

        const historyForAgent = contexts.get(contextId) || [];

        if (!historyForAgent.find((m) => m.messageId === userMessage.messageId)) {
            historyForAgent.push(userMessage);
        }
        contexts.set(contextId, historyForAgent);
        logger.info(`[A2A-EXECUTE] context history length=${historyForAgent.length} for contextId=${contextId}`);

        // Convert A2A messages to LangChain format (via helper)
        const messages = a2aMessagesToLangChain(historyForAgent);
        logger.info("[A2A-EXECUTE] LangChain messages:", JSON.stringify(messages, null, 2));

        let res;

        const textParts = userMessage.parts.filter((part) => part.kind == "text");
        const messageText = textParts.map((part) => part.text).join(" ");

        // If resuming a task
        if (requestContext.task) {
            logger.info(`[A2A-EXECUTE] resuming task taskId=${requestContext.taskId}, messageText: ${messageText}`);
            logger.info("[A2A-EXECUTE] resume Command input (full userMessage):", JSON.stringify(userMessage, null, 2));
            res = await this.app.stream(
                new Command({ resume: messageText }),
                { configurable: { thread_id: requestContext.taskId } }
            )
        } else {
            logger.info(`[A2A-EXECUTE] starting new task taskId=${taskId}`);
            res = await this.app.stream(
                { messages },
                {
                    configurable: { thread_id: taskId }
                }
            );
        }

        let finalRes = "";
        let chunkIndex = 0;
        for await (const chunk of res) {
            logger.info(`[A2A-STREAM] chunk[${chunkIndex}]:`, JSON.stringify(chunk, null, 2));
            chunkIndex++;

            if(!("__interrupt__" in chunk)) {
                const agentMessages = chunk.agent?.messages;
                if(Array.isArray(agentMessages)) {
                    const agentMessage = agentMessages[agentMessages.length -1];
                    if(agentMessage instanceof Object && "content" in agentMessage) {
                        logger.info("[A2A-STREAM] accumulating agent content:", agentMessage.content);
                        finalRes += agentMessage.content;
                    }
                }
                continue
            }

            logger.info("[A2A-STREAM] interrupt detected in chunk:", JSON.stringify(chunk, null, 2));
            type InterruptChunk = {
                __interrupt__: Array<{
                    value: unknown;
                }>;
            };
            const interruptValue = (chunk as InterruptChunk).__interrupt__[0].value
            logger.info("[A2A-STREAM] interrupt value:", JSON.stringify(interruptValue, null, 2));
            const interruptUpdate: TaskStatusUpdateEvent = createInterruptUpdate(interruptValue as string, {taskId, contextId});
            this.publishAndLog(eventBus, interruptUpdate, "interrupt status update");
            eventBus.finished();
            logger.info(`[A2A-EXECUTE] task ${taskId} finished via interrupt`);
            return
        }

        logger.info(`[A2A-EXECUTE] stream ended. finalRes length=${finalRes.length}, content: ${finalRes}`);

        const finalMessage: Message = createMessage(finalRes, {taskId, contextId});
        logger.info("[A2A-EXECUTE] finalMessage:", JSON.stringify(finalMessage, null, 2));

        historyForAgent.push(finalMessage);
        contexts.set(contextId, historyForAgent);

        const finalUpdate: TaskStatusUpdateEvent = createMessageUpdate(finalMessage, {taskId, contextId, final: true});
        this.publishAndLog(eventBus, finalUpdate, "final status update (completed)");

        eventBus.finished();
        logger.info(`[A2A-EXECUTE] task ${taskId} finished with state: completed`);
    }

    public cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {};

    private shouldContinue(state: AgentGraphState) {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1] as { tool_calls?: unknown[] } | undefined;

        if (lastMessage?.tool_calls?.length) {
            logger.info("[A2A-GRAPH] routing to tools node, tool_calls:", JSON.stringify(lastMessage.tool_calls, null, 2));
            return "tools";
        }
        
        return END;
    }
}
