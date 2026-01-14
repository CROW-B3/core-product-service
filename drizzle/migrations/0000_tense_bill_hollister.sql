CREATE TABLE `crawler_job` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`onboardingId` text,
	`sourceType` text NOT NULL,
	`sourceValue` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`productsFound` integer DEFAULT 0 NOT NULL,
	`productsProcessed` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`startedAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`externalId` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`images` text NOT NULL,
	`price` integer,
	`category` text,
	`metadata` text,
	`crawlerJobId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`crawlerJobId`) REFERENCES `crawler_job`(`id`) ON UPDATE no action ON DELETE set null
);
