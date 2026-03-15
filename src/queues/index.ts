import type { CrawlJobMessage, Environment } from '../types';
import { processProductCrawlJob } from './product-crawl';

const processQueueMessage = async (
  environment: Environment,
  message: Message<CrawlJobMessage>
) => {
  await processProductCrawlJob(environment, message.body);
  message.ack();
};

const handleMessageProcessingError = (
  message: Message<CrawlJobMessage>,
  error: unknown
) => {
  console.error('Queue processing error:', error);
  message.retry();
};

export const handleQueueBatch = async (
  batch: MessageBatch<CrawlJobMessage>,
  environment: Environment
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await processQueueMessage(environment, message);
    } catch (error) {
      handleMessageProcessingError(message, error);
    }
  }
};
