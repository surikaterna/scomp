import { Scomp } from '..';
import { Logger, LoggerFactory } from 'slf';
LoggerFactory.setFactory((e) => console.log(e.name, e.params.join(' ')));

const LOG = Logger.getLogger('scomp:client');

LOG.debug('HI', { ts: 0 });

describe('Scomp', () => {
  it('should do something', (done) => {
    // Scomp.request('viewdb');
    // Creates a proxy
    const viewdb = new Scomp().client('viewdb');
    //viewdb.query('shipments').then();
   /* viewdb.observe('shipments', {}).next((ev) => {
      //_process(ev);
      done();
    }).error((err) => {
      done(err);
    });
    */
  });
});
