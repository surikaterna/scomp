import {
	createScompClient,
	createScompFeed,
	createScompService
} from '@scomp/core';
import { createInprocessTransport } from '@scomp/transport-inprocess';

/**
 * Runs a local demo showcasing request, feed, and command service methods.
 */
async function main() {
	const service = createScompService()
		.request('sum', async (left: number, right: number) => left + right)
		.feed('countTo', async function* (limit: number) {
			for (let value = 1; value <= limit; value += 1) {
				yield value;
			}
		})
		.feed('watch', () => {
			const feed = createScompFeed<number>();
			queueMicrotask(() => {
				feed.next(42).complete();
			});
			return feed;
		})
		.command('log', (message: string): void => {
			console.log('command:', message);
		})
		.build();

	const transport = createInprocessTransport(service);
	const client = createScompClient(service, transport);

	const sumResult = await client.sum(2, 3);
	console.log('sum result:', sumResult);

	const counted: Array<number> = [];
	for await (const value of client.countTo(3)) {
		counted.push(value);
	}
	console.log('count feed:', counted);

	const watched: Array<number> = [];
	for await (const value of client.watch()) {
		watched.push(value);
	}
	console.log('watch feed:', watched);

	client.log('fire-and-forget from demo');
}

void main();
