import { Scomp, ScompServer } from '..';
import { Logger, LoggerFactory } from 'slf';
import should from 'should';
LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const LOG = Logger.getLogger('scomp:client');

LOG.debug('HI', { ts: 0 });
const scomp = new Scomp();
const server = new ScompServer(scomp);

describe('Scomp', () => {
  it('should be possible to call service', (done) => {
    server.use('window', {
      alert: msg => console.log('Server alert', msg)
    });

    server.use('timeService', {
      tick: (time, wire) => {
        LOG.debug('timeService ', time, wire);
        setInterval(() => {
          wire.response(new Date().getTime());
        }, time);
      }
    });

    scomp.client().timeService.tick(50).then((timeServiceObservable) => {
      let count = 0;
      timeServiceObservable.onNext(time => {
        LOG.debug('Response ', time);
        should.exist(time);
        if (count === 10) {
          //TODO need to fix unsubscribe, client and server.
          timeServiceObservable.unsubscribe();
          timeServiceObservable.isUnsubscribed().should.equal(true);
          done();          
        }
        count++;
      }).onError(err => {
        should.not.exist(err);
        done();
      });
    });    
    
  });
  it('should be possible to call function on remote service', function (done) {
    server.use('timeService2', {
      get: (timer, wire) => {
        LOG.debug('Time service ', timer);
        return {
          tick: (time, wire) => {
            console.log(time);
            LOG.debug('timeService ', time, wire);
            setInterval(() => {
              wire.response(new Date().getTime());
            }, time);
          }
        }
      }
    });

    scomp.client().timeService2.get('timer2').tick(150).then((timeServiceObservable) => {
      let count = 0;
      timeServiceObservable.onNext(time => {
        LOG.debug('Response ', time);
        should.exist(time);
        if (count === 1) {
          timeServiceObservable.unsubscribe();
          timeServiceObservable.isUnsubscribed().should.equal(true);
          done();          
        }
        count++;
      });          
    });



    // Scomp.request('viewdb');
    // Creates a proxy
    //    const viewdb = new Scomp().client().viewdb;//('viewdb');
    //    viewdb.query('shipments');


    /*scomp.client().notificationService.find('1').then( (notifications) => {
    });*/




    //scomp.client().saft.get('test').banan();
    //scomp.call(saft.get('test').banan());


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
