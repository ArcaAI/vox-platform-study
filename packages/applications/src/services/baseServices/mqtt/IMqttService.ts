// TODO: Implement this

/**
 * Interface representing an MQTT service for sending messages.
 */
export interface IMqttService {
    /**
     * Sends a message to a specified topic.
     *
     * @param topic - The topic to which the message will be sent.
     * @param message - The message content to be sent.
     * @returns A promise that resolves when the message has been sent.
     */
    sendMessage(topic: string, message: string): Promise<void>;
}

/**
 * Symbol used to identify the IMqttService interface in dependency injection.
 */
export const IMqttService = Symbol('IMqttService');
