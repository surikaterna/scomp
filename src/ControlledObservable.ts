import Observable, { ObservableFunc } from './Observable';

type Controller = Record<string, any>;

/**
 * new ControlledObservable(function(), function(function onNext, function onError, function onComplete) observable) -> Observable
 */
export default class ControlledObservable extends Observable {
  private _onController?: Controller;

  constructor(controller: Controller, fn: ObservableFunc) {
    super(fn);
    this.setController(controller);
  }

  getController() {
    return this._onController;
  }

  setController(controller: Controller) {
    this._onController = controller;
    return this;
  }
}
