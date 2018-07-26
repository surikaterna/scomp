import ServerSocketWire from '../src/socket/ServerSocketWire';
import Observable from '../src/Observable';
import { Scomp, ScompServer } from '..';
import { LoggerFactory } from 'slf';

LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const serverWire = new ServerSocketWire();

const server = new ScompServer(new Scomp(serverWire));
const port = 3001;

server.use('timeService', {
  tick: (time) => {
    const state = {};
    return new Observable((next) => {
      const run = () => { next(new Date().getTime()); };
      state._interval = setInterval(run, time);
    }).onUnsubscribe(() => {
      clearInterval(state._interval);
    });
  }
});

console.log('Server listening on port ', port);
serverWire.listen(port);


