import { subtle } from 'crypto';
import Observable from '../observable/Observable';
import { Subscriber } from '../observable/Subscriber';
import Wire from '../wire/Wire';
import Client from './Client';

class LoopbackWire implements Wire {
  readonly connected = new Observable<boolean>((subscriber) => {
    subscriber.next(true);
  });
  readonly incomingPackets = new Observable<WireResponse>((Subscriber) => {});
  request(packet: WireRequest) {
    console.log('req', packet);
  }
  close() {}
}

type Document = Record<string, any>;

interface ViewDbObserve<T> {}

interface ViewDbCursor<T> {
  limit(limit: number);
  toArray(): Promise<Array<T>>;
//   @ScompCall()
  observe(options: { init?: (documents?: Array<Document>) => void }): ViewDbObserve<Document>;
}

export type Query = Record<string, any>;
export type FindOptions = Record<string, any>;

interface ViewDbCollection {
  find(query: Query, options?: FindOptions): ViewDbCursor<Document>;
}

interface ViewDb {
  collection(name: string): ViewDbCollection;
}

describe.only('Client', () => {
  test('Instantiate a Client', () => {
    const client = new Client(new LoopbackWire());
  });
  test.only('Call VDB toArray', (done) => {
    const client = new Client(new LoopbackWire());
    const viewDb = client.link<ViewDb>('lx.viewdb');
    viewDb
      .collection('users')
      .find({ id: 12 })
      .toArray()
      .then((arr) => {
        console.log('find users', arr);
        done();
      });
  });
  test('Call VDB observe', (done) => {
    const client = new Client(new LoopbackWire());
    const viewDb = client.link<ViewDb>('lx.viewdb');
    viewDb
      .collection('users')
      .find({ id: 12 })
      .observe({
        init: (i) => {
          console.log('init', i);
        }
      });
  });
});
