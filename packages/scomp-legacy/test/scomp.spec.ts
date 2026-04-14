import { Scomp } from '../src/scomp';
import { ScompServer } from '../src/server/ScompServer';
import Observable from '../src/Observable';
import ControlledObservable from '../src/ControlledObservable';
import NullWire from '../src/null';
import { Logger, LoggerFactory } from 'slf';
import Promise from 'bluebird'
import { createScompFeed } from '@scomp/core';
LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const LOG = Logger.getLogger('scomp:client');
const scomp = new Scomp(new NullWire());
const server = new ScompServer(scomp);

describe('Scomp', () => {
  it('should be possible to call service', (done) => {
    server.use('window', {
      alert: (msg: any) => console.log('Server alert', msg)
    });

    server.use('timeService', {
      tick: (time: any) => {
        LOG.debug('timeService ', time);
        const state: any = {};
        return new Observable((next) => {
          const run = () => { next(new Date().getTime()); }
          state._interval = setInterval(run , time);
        }).onUnsubscribe(() => {
          clearInterval(state._interval);
        });        
      }
    });

    scomp.client().timeService.tick(10).then((timeServiceObservable: any) => {
      let count = 0;
      timeServiceObservable.onNext((time: any) => {
        LOG.debug('Response ', time);
        expect(time).toBeDefined();
        if (count === 10) {
          //TODO need to fix unsubscribe, client and server.
          timeServiceObservable.unsubscribe();
          expect(timeServiceObservable.isUnsubscribed()).toBe(true);
          done();          
        }
        count++;
      }).onError((err: any) => {
        expect(err).toBeUndefined();
        done();
      });

    });    
    
  });

  it('should be possible to call function on remote service', function (done) {
    server.use('timeService2', {
      get: (timer: any) => {
        LOG.debug('Time service ', timer);
        return {
          tick: (time: any) => {
            LOG.debug('timeService ', time);
            const state: any = {};
            return new Observable((next) => {
              state._interval = setInterval(() => {
                next(new Date().getTime());
              }, time);
            }).onUnsubscribe(() => {
              clearInterval(state._interval);
            });
          }
        }
      }
    });

    scomp.client().timeService2.get('timer2').tick(10).then((timeServiceObservable: any) => {
      let count = 0;
      timeServiceObservable.onNext((time: any) => {
        LOG.debug('Response ', time);
        expect(time).toBeDefined();
        if (count === 1) {
          timeServiceObservable.unsubscribe();
          expect(timeServiceObservable.isUnsubscribed()).toBe(true);
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
  
  it('should be possible to get none observable value', function (done) {
    let _count: any;
    server.use('counter', {
      next: () => {
        if (!_count) {
          _count = 0;
        }
        LOG.debug('counter ', ++_count);
        return _count;
      }
    });    

    scomp.client().counter.next().then((count: any) => {
      if (count === 1) {
        done();          
      }
    });


  });

  it('should return error if path does not exists', function (done) {
    server.use('a', {
      b: () => {
      }
    });

    scomp.client().a.b.c.next().then((test: any) => {
    }).catch((err: any) => {
      console.log(err);
      done();
    });
  });  

  it('should return error if server error', function (done) {
    server.use('a', {
      b: () => {
        throw new Error('Simple error');
      }
    });
    scomp.client().a.b().then((test: any) => {
    }).catch((err: any) => {
      console.log(err);
      done();
    });
  });  
  
  it('should wait for promises to be done', function (done) {
    server.use('promiseService', {
      waitForResponse: () => {
        return new Promise((resolve) => {
          resolve({
            waitForResponse: (data: any) => {
              return new Promise((resolve) => {
                setTimeout(() => { resolve(data.message) }, 10);
              });
            }                  
          })    
        });
      }
    });
    scomp.client().promiseService.waitForResponse().waitForResponse({ message: 'Hej' }).then(() => {
      done();
    }).catch(done);
  });    

  let run: any;
  it('should be possible to control a observable', (done) => {
    server.use('timeService', {
      tick: (time: any) => {
        LOG.debug('timeService ', time);
        const state: any = {};
        return new ControlledObservable({
          tick : (time: any) => {
            clearInterval(state._interval)
            state._interval = setInterval(run, time)
            return time;
          },
        }, (next) => {
          run = () => { next(new Date().getTime()); }
          state._interval = setInterval(run , time);
        }).onUnsubscribe(() => {
          clearInterval(state._interval);
        });
      }
    });

    scomp.client().timeService.tick(10).then((timeServiceObservable: any) => {
 
      timeServiceObservable.controller.tick(20).then((tick: any) => {
        expect(tick).toBe(20);
      });

      timeServiceObservable.onNext((time: any) => {
        expect(time).toBeDefined();
        timeServiceObservable.unsubscribe();
        done();
      }).onError((err: any) => {
        expect(err).toBeUndefined();
        done();
      });

    });    
    
  });

  it('should stream from ScompFeed-like response', (done) => {
    server.use('feedService', {
      tick: () => {
        const state: { interval?: NodeJS.Timeout } = {};
        const feed = createScompFeed<number>();
        let count = 0;
        state.interval = setInterval(() => {
          feed.next(++count);
        }, 5);

        return feed.onUnsubscribe(() => {
          if (state.interval) {
            clearInterval(state.interval);
          }
        });
      }
    });

    scomp.client().feedService.tick().then((stream: any) => {
      let seen = 0;
      stream.onNext((value: number) => {
        expect(value).toBeDefined();
        seen++;
        if (seen >= 2) {
          stream.unsubscribe();
          done();
        }
      }).onError((err: any) => done(err));
    }).catch(done);
  });

  it('should stream from async generator response', (done) => {
    server.use('generatorService', {
      tick: async function* () {
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield i;
        }
      }
    });

    scomp.client().generatorService.tick().then((stream: any) => {
      let seen = 0;
      stream.onNext((value: number) => {
        expect(value).toBeDefined();
        seen++;
        if (seen >= 2) {
          stream.unsubscribe();
          done();
        }
      }).onError((err: any) => done(err));
    }).catch(done);
  });
});

