import ClientSocketWire from './socket/ClientSocketWire';
import Observable from './Observable';
import { Scomp } from './scomp';
import { LoggerFactory } from 'slf';

/**
 * Legacy manual test client used for socket interoperability verification.
 */
LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const clientWire = new ClientSocketWire({ address: 'http://127.0.0.1/3001', bidirectional: false });

const scomp = new Scomp(clientWire);

interface ServerScompApi {
  timeService: TimeService
}

interface TimeService {
  tick: (ms: number) => Promise<Observable>
}

clientWire.on('connect', () => {
  // proxy
  scomp.client<ServerScompApi>().timeService.tick(1000).then((observable) => {
    observable.onNext(time => {
      console.log('onNext ' + time);
    }).onError(err => {
      console.log(err);
    });
  });
});

clientWire.on('disconnect', () => {
  console.log('disconnect');
});
