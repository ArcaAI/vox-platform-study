export abstract class Singleton {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
