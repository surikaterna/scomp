import ClientSocketWire from '../src/socket/ClientSocketWire';
import Observable from '../src/Observable';
import { Scomp} from '..';
import { LoggerFactory } from 'slf';

LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const clientWire = new ClientSocketWire();

const scomp = new Scomp(clientWire);

clientWire.on('connect', () => {
  scomp.client().timeService.tick(1000).then((observable) => {
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
