import Observable from './Observable';

describe('Observable', () => {
  test('Instantiate an Observable', () => {
    new Observable((value) => {});
  });

  test('next()', (done) => {
    const observable = new Observable<number>((subscriber) => {
      subscriber.next(1);
      subscriber.next(2);
      subscriber.next(3);
      setTimeout(() => {
        subscriber.next(4);
        subscriber.complete();
      }, 100);
    });

    let lastValue = 0;
    observable.subscribe({
      next(x) {
        lastValue = x;
      },
      error(err) {},
      complete() {
        if (lastValue === 4) {
          done();
        } else {
          done('Error, unexpected value', lastValue);
        }
      }
    });
  });
});
