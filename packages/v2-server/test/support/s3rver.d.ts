declare module "s3rver" {
	export default class S3rver {
		constructor(options: Record<string, unknown>);
		run(): Promise<unknown>;
		close(): Promise<void>;
	}
}
