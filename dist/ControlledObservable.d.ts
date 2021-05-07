import Observable, { ObservableFunc } from './Observable';
declare type Controller = Record<string, any>;
/**
 * new ControlledObservable(function(), function(function onNext, function onError, function onComplete) observable) -> Observable
 */
export default class ControlledObservable extends Observable {
    private _onController?;
    constructor(controller: Controller, fn: ObservableFunc);
    getController(): Record<string, any> | undefined;
    setController(controller: Controller): this;
}
export {};
