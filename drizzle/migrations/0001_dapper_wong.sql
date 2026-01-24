CREATE TABLE `product_ai_description` (
	`id` text PRIMARY KEY NOT NULL,
	`productId` text NOT NULL,
	`imageUrl` text NOT NULL,
	`description` text NOT NULL,
	`features` text,
	`colors` text,
	`materials` text,
	`style` text,
	`modelUsed` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`productId`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE cascade
);
