import type { CrawlJobMessage, Environment } from '../types';
import { processProductCrawlJob } from './product-crawl';

const processQueueMessage = async (
  environment: Environment,
  message: Message<CrawlJobMessage>
) => {
  const { jobId } = message.body;
  const attempt = message.attempts + 1;
  console.warn(`[QUEUE] Processing job ${jobId} (attempt ${attempt})`);

  await processProductCrawlJob(environment, message.body);
  message.ack();

  console.warn(`[QUEUE] Job ${jobId} completed successfully`);
};

const handleMessageProcessingError = (
  message: Message<CrawlJobMessage>,
  error: unknown
) => {
  const { jobId } = message.body;
  const attempt = message.attempts + 1;
  console.error(`[QUEUE] Job ${jobId} failed on attempt ${attempt}:`, error);

  if (attempt >= 3) {
    console.error(
      `[QUEUE] Job ${jobId} exhausted all retries, acknowledging to prevent infinite loop`
    );
    message.ack();
  } else {
    console.warn(`[QUEUE] Job ${jobId} will be retried`);
    message.retry();
  }
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
