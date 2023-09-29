import ServerSocketWire from './socket/ServerSocketWire';
import Observable from './Observable';
import { LoggerFactory } from 'slf';
import { ScompServer } from './server/ScompServer';
import { Scomp } from './Scomp';

LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const serverWire = new ServerSocketWire({ bidirectional: false });

const server = new ScompServer(new Scomp(serverWire));
const port = 3001;

server.use('timeService', {
  tick: (ms: number) => {
    const state: any = {};
    return new Observable((next) => {
      const run = () => {
        try {
          next(new Date().getTime()); 
        } catch (e) {
          console.log(e);
        }
      };
      state._interval = setInterval(run, ms);
    }).onUnsubscribe(() => {
      clearInterval(state._interval);
    });
  }
});

console.log('Server listening on port ', port);
serverWire.listen();


