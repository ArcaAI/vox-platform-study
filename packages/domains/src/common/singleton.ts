export abstract class Singleton {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one map holds instances of every unrelated Singleton subclass; `getInstance<T>`'s return type is what gives call sites their real type, `unknown` here would just force an explicit cast at every call site instead
  private static instances: Map<string, any> = new Map();

  protected constructor() {}

  public static getInstance<T>(this: new () => T): T {
    const className = this.name;

    if (!Singleton.instances.has(className)) {
      Singleton.instances.set(className, new this());
    }

    return Singleton.instances.get(className);
  }
}
