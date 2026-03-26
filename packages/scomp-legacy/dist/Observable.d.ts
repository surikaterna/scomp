/**
 * new Observable(function(function onNext, function onError, function onComplete) observable) -> Observable
 */
declare type onNextFunc = (next: any) => void;
declare type onErrorFunc = any;
declare type onCompleteFunc = any;
declare type DefaulteErrorType = Error;
export declare type ObservableFunc = (next: onNextFunc, error: onErrorFunc, complete: onCompleteFunc) => void;
export default class Observable<ResponseType = any, ErrorType = DefaulteErrorType> {
    private _onNextListener?;
    private _onErrorListener?;
    private _onCompleteListener?;
    private _onUnsubscribe?;
    controller: any | null;
    constructor(fn: ObservableFunc);
    unsubscribe(): void;
    isUnsubscribed(): boolean;
    next(nextResponse: any): void;
    error(errorResponse: any): void;
    complete(completeResponse: any): void;
    onNext(fn: (res: ResponseType) => void): this;
    onError(fn: (err: DefaulteErrorType) => void): this;
    onComplete(fn: (res: any) => void): this;
    onUnsubscribe(fn: () => void): this;
}
export {};
