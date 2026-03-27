export interface GetUserInput {
  id: number;
}

export interface UserRecord {
  id: number;
  name: string;
}

export interface NotifyLoginInput {
  userId: number;
  at: string;
}

export interface LiveTickerInput {
  channel: string;
}

export interface LiveTickerTick {
  channel: string;
  sequence: number;
  at: string;
}

export interface DemoApiContract {
  users: {
    getUser(input: GetUserInput): Promise<UserRecord>;
    notifyLogin(input: NotifyLoginInput): Promise<void>;
    liveTicker(input: LiveTickerInput): AsyncIterable<LiveTickerTick>;
  };
}
