import { v4 as uuidv4 } from "uuid";
import { MessageSendParams, Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
} from "@a2a-js/sdk/server";
import { ALLOWED_PUSH_NOTIFICATION_URLS } from "./utils/helpers";

class CustomRequestHandler extends DefaultRequestHandler {

    public async sendMessage(params: MessageSendParams): Promise<Message | Task> {
        validatePushNotificationURL(params.configuration?.pushNotificationConfig?.url)
        return super.sendMessage(ensureMessageId(params));
    }

    public sendMessageStream(params: MessageSendParams): AsyncGenerator<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
        validatePushNotificationURL(params.configuration?.pushNotificationConfig?.url)
        return super.sendMessageStream(ensureMessageId(params));
    }
}

function ensureMessageId(params: MessageSendParams): MessageSendParams {
    if (params.message.messageId) return params;
    return { ...params, message: { ...params.message, messageId: uuidv4() } };
}

function isHostAllowed(host: string, pattern: string): boolean {
    const h = host.toLowerCase().replace(/\.+$/, '');
    const p = pattern.toLowerCase().replace(/\.+$/, '');
    return h === p || h.endsWith(`.${p}`);
}

function validatePushNotificationURL(url?: string) {
    if (!url) return;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid Push Notification URL: "${url}"`);
    }

    const host = parsed.hostname;
    const isValid = ALLOWED_PUSH_NOTIFICATION_URLS.some(pattern => isHostAllowed(host, pattern));

    if (!isValid) {
        throw new Error(`Push Notification URL "${url}" is not allowed. Allowed domains are: ${ALLOWED_PUSH_NOTIFICATION_URLS.join(", ")}`);
    }
}

export { CustomRequestHandler };