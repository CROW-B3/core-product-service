import type { CrawlJobMessage, Environment } from '../types';
import { processProductCrawlJob } from './product-crawl';

export const handleQueueBatch = async (
  batch: MessageBatch<CrawlJobMessage>,
  env: Environment
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await processProductCrawlJob(env, message.body);
      message.ack();
    } catch (error) {
      console.error('Queue processing error:', error);
      message.retry();
    }
  }
};
