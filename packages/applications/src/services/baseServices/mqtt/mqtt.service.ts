import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject } from '@nestjs/common';
import { MqttClient, connect } from 'mqtt';
import { IMqttService } from './IMqttService';
import { IConfigService } from '../_meta/';

// TODO: Implement this

/**
 * MqttService is responsible for managing the MQTT client connection,
 * subscribing to topics, and handling incoming messages.
 */
@Injectable()
export class MqttService implements IMqttService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client!: MqttClient;

  /**
   * Constructs an instance of MqttService.
   * @param configService - The configuration service used to retrieve MQTT connection settings.
   */
  constructor(@Inject(IConfigService) private readonly configService: IConfigService) {
    this.logger.log({
      message: 'Service created',
      service: MqttService.name,
    });
  }

  /**
   * Initializes the MQTT client connection when the module is initialized.
   * Retrieves configuration settings for the MQTT broker and connects to it.
   */
  onModuleInit() {
    const host = this.configService.getConfiguration().MQTT_HOST || 'localhost';
    const port = this.configService.getConfiguration().MQTT_PORT || 1883;
    const username = this.configService.getConfiguration().MQTT_USER;
    const password = this.configService.getConfiguration().MQTT_PASS;

    // Connect to the MQTT broker
    this.client = connect(`${host}:${port}`, {
      username,
      password,
    });

    this.logger.debug({
      message: 'Connecting to MQTT broker',
      host,
      port,
    });

    // Set up event handlers for the MQTT client
    this.client.on('connect', () => {
      this.logger.log({
        message: 'Connected to MQTT broker',
        host,
        port,
      });
      this.subscribeToTopics();
    });

    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message.toString());
    });

    this.client.on('error', (error) => {
      this.logger.error({
        message: 'MQTT connection error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Cleans up the MQTT client connection when the module is destroyed.
   */
  onModuleDestroy() {
    if (this.client) {
      this.client.end();
    }
  }

  /**
   * Subscribes to predefined MQTT topics.
   * Logs success or failure of the subscription.
   */
  private subscribeToTopics() {
    const topics = ['sms/marketing', 'sms/contact', 'sms'];
    this.client.subscribe(topics, (error, granted) => {
      if (error) {
        this.logger.error({
          message: 'Failed to subscribe to topics',
          topics,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        this.logger.log({
          message: 'Subscribed to topics',
          topics: granted?.map((g) => g.topic),
        });
      }
    });
  }

  /**
   * Handles incoming messages from subscribed topics.
   * @param topic - The topic on which the message was received.
   * @param message - The message content.
   */
  private handleMessage(topic: string, message: string) {
    this.logger.log({
      message: 'Received message',
      topic,
      messageLength: message.length,
    });
    // Implement your message processing logic here
  }

  /**
   * Publishes a message to a specified topic.
   * @param topic - The topic to which the message will be published.
   * @param message - The message content to be sent.
   * @returns A promise that resolves when the message is published successfully.
   */
  public sendMessage(topic: string, message: string) {
    return new Promise<void>((resolve, reject) => {
      this.client.publish(topic, message, (error) => {
        if (error) {
          this.logger.error({
            message: 'Failed to publish message',
            topic,
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        } else {
          this.logger.log({
            message: 'Published message',
            topic,
            messageLength: message.length,
          });
          resolve();
        }
      });
    });
  }
}
