export type AnyContractMethod = (input: any) => any;

export type ContractMethodInput<Method> =
  Method extends (input: infer Input, ...args: Array<any>) => any ? Input : never;

export type ContractMethodOutput<Method> =
  Method extends (...args: Array<any>) => Promise<infer Output> ? Output
    : Method extends (...args: Array<any>) => AsyncIterable<infer Output> ? Output
      : never;

export type MethodNetworkIntent<Method> =
  Method extends (...args: Array<any>) => AsyncIterable<infer Output>
    ? {
      type: 'feed';
      input: ContractMethodInput<Method>;
      output: Output;
    }
    : Method extends (...args: Array<any>) => void | Promise<void>
      ? {
        type: 'signal';
        input: ContractMethodInput<Method>;
      }
      : Method extends (...args: Array<any>) => Promise<infer Output>
        ? {
          type: 'request';
          input: ContractMethodInput<Method>;
          output: Output;
        }
        : never;

export type ContractNetworkIntent<Contract extends Record<string, any>> = {
  [MethodName in keyof Contract as Contract[MethodName] extends AnyContractMethod
    ? MethodName
    : never]: MethodNetworkIntent<Contract[MethodName]>;
};

type MergeUnion<UnionType> = (
  UnionType extends any ? (input: UnionType) => void : never
) extends ((input: infer Intersection) => void)
  ? { [Key in keyof Intersection]: Intersection[Key] }
  : never;

type JoinRoute<Prefix extends string, Key extends string> = Prefix extends ''
  ? Key
  : `${Prefix}.${Key}`;

type FlatContractRouteUnion<Contract, Prefix extends string = ''> =
  Contract extends (...args: Array<any>) => any
    ? {
      [Route in Prefix]: MethodNetworkIntent<Contract>;
    }
    : Contract extends Record<string, any>
      ? {
        [Key in keyof Contract & string]: FlatContractRouteUnion<Contract[Key], JoinRoute<Prefix, Key>>;
      }[keyof Contract & string]
      : never;

export type ContractRouteIntents<Contract extends Record<string, any>> = MergeUnion<
  FlatContractRouteUnion<Contract>
>;
