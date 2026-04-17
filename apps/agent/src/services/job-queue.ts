import PgBoss from "pg-boss";

export interface JobQueueConfig {
  connectionString: string;
}

export interface EnqueueOptions {
  singletonKey?: string;
  expireInMinutes?: number;
  retryLimit?: number;
  retryDelay?: number;
}

export type Job<T> = PgBoss.Job<T>;

export class JobQueue {
  private readonly boss: PgBoss;

  constructor(config: JobQueueConfig) {
    this.boss = new PgBoss(config.connectionString);
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    options: EnqueueOptions = {}
  ): Promise<string | null> {
    const {
      singletonKey,
      expireInMinutes,
      retryLimit = 2,
      retryDelay = 30,
    } = options;

    return this.boss.send(name, data, {
      singletonKey,
      expireInMinutes,
      retryLimit,
      retryDelay,
    });
  }

  registerWorker<T extends object>(
    name: string,
    handler: (job: Job<T>) => Promise<void>,
    options: { teamSize?: number } = {}
  ): void {
    const { teamSize = 1 } = options;
    this.boss.work(name, { teamSize } as any, (job: any) => handler(job as Job<T>));
  }
}
