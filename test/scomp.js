import { Scomp, ScompServer } from '..';
import { Logger, LoggerFactory } from 'slf';
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

    //Void
    scomp.client().window.alert('Hej!');

    //Callback
    scomp.client().window.alert('Hej!').then((message) => {
      console.log(message);
    });


    //Stream
    
    //subscribe, observe, stream
    scomp.client().subscribe('notifications').onEvent((event, error) => {

    });

    scomp.client().notifications.observe((event, error) => {

    });


    //scomp.client().saft.get('test').banan();
    //scomp.call(saft.get('test').banan());

    const server = new ScompServer(scomp);
    server.use('window', {
      alert: msg => console.log('Server alert', msg)
    });

    //    new Scomp().client().devices.x1231234532.window.alert('think quick');
    //new Scomp().client().saft.get('messageService').alert('think quick');
    done();
    /* viewdb.observe('shipments', {}).next((ev) => {
       //_process(ev);
       done();
     }).error((err) => {
       done(err);
     });
     */
  });
});
