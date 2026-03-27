import Observable, { ObservableFunc } from './Observable';

type Controller = Record<string, any>;

/**
 * Observable that carries a mutable controller object.
 */
export default class ControlledObservable extends Observable {
  private _onController?: Controller;

  /**
   * Creates a controlled observable.
   */
  constructor(controller: Controller, fn: ObservableFunc) {
    super(fn);
    this.setController(controller);
  }

  /** Returns the current controller object. */
  getController() {
    return this._onController;
  }

  /** Replaces the controller object. */
  setController(controller: Controller) {
    this._onController = controller;
    return this;
  }
}
