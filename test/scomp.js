import { Scomp, ScompServer } from '..';
import { Logger, LoggerFactory } from 'slf';
import should from 'should';
LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const LOG = Logger.getLogger('scomp:client');

LOG.debug('HI', { ts: 0 });

describe('Scomp', () => {
  it('should do something', (done) => {
    // Scomp.request('viewdb');
    // Creates a proxy
    //    const viewdb = new Scomp().client().viewdb;//('viewdb');
    //    viewdb.query('shipments');
    const scomp = new Scomp();
    scomp.client().timeService.ticks(10).then((timeServiceObservable) => {
      timeServiceObservable.onNext(time => {
        should.exist(time);
        console.log(time);
        done();
      }).onError(err => {
        should.not.exist(err);
        done();
      });
    });

    /*scomp.client().notificationService.find('1').then( (notifications) => {
    });*/




    //scomp.client().saft.get('test').banan();
    //scomp.call(saft.get('test').banan());

    const server = new ScompServer(scomp);
    server.use('window', {
      alert: msg => console.log('Server alert', msg)
    });

    //    new Scomp().client().devices.x1231234532.window.alert('think quick');
    //new Scomp().client().saft.get('messageService').alert('think quick');
    //done();
    /* viewdb.observe('shipments', {}).next((ev) => {
       //_process(ev);
       done();
     }).error((err) => {
       done(err);
     });
     */
  });
});
