import fs from 'node:fs';
import path from 'node:path';

import { type Application } from 'express-ws';
import { Model, Sequelize } from 'sequelize';
import expressApp from './application.js';
import Router from './Router.js';
import Server from './Server.js';

import { type Config } from './types.js';
import Controller from './Controller.js';

export default class Nails {
  static Controller = Controller;
  private static instance: Nails;

  static get sequelize() {
    return this.instance.sequelize;
  }

  static get initialized() {
    return this.instance.initialized;
  }

  static get config() {
    return this.instance.config;
  }

  static get application() {
    return this.instance.application;
  }

  static get server() {
    return this.instance.server;
  }

  static get httpServer() {
    return this.instance.httpServer;
  }

  static get httpsServer() {
    return this.instance.httpsServer;
  }

  static get lameDuckMode() {
    return this.instance.lameDuckMode;
  }

  static set lameDuckMode(value: boolean) {
    this.instance.lameDuckMode = value;
  }

  // static initModel<T extends Model>(modelClass: ModelStatic<T>, attributes: ModelAttributes, options?: InitOptions) {
  //   const actualOptions = {...options, sequelize: this.sequelize}
  //   modelClass.init(attributes, actualOptions);
  // }

  declare ready: Promise<boolean>;
  declare config: Config;
  declare application: Application;
  declare Controller: typeof Controller;
  declare sequelize: Sequelize;
  declare initialized: Promise<void>;
  declare router: Router;
  declare server: Server;
  declare Model: Model;
  declare Models: Record<string, typeof Model>;

  private modelFinalizations: (() => Promise<void>)[] = [];
  private modelMigrations: (() => Promise<void>)[] = [];

  get httpServer() {
    return this.server.httpServer;
  }

  get httpsServer() {
    return this.server.httpsServer;
  }

  get lameDuckMode(): boolean {
    return this.server.lameDuckMode;
  }

  set lameDuckMode(value: boolean) {
    this.server.lameDuckMode = value;
  }

  get healthy(): boolean {
    return this.server.healthy;
  }

  set healthy(value: boolean) {
    this.server.healthy = value;
  }

  constructor(appConfig: Config) {
    Nails.instance = this;
    this.config = appConfig;
    this.application = expressApp;
    this.Models = {};
    this.Controller = Controller;
    this.sequelize = this.config.db.options
      ? new Sequelize(
        this.config.db.address,
        this.config.db.options)
      : new Sequelize(this.config.db.address);
    this.router = new Router([]);
    this.server = new Server(this.config, this.application, async () => {
      if (this.sequelize) {
        await this.sequelize.authenticate();
      }
      return true;
    });
    this.initialized = this.configure();
  }

  async configure() {
    expressApp.set('nails_config', { config: this.config });
    expressApp.set('view engine', 'ejs');
    expressApp.set('views', this.config.service.VIEWS_ROOT);
    expressApp.set("public_root", this.config.service.PUBLIC_ROOT);
    console.log("Initializing Router...");
    // this.router = new Router( app_config.routes || [] );
    console.log("Application Router initialized");
    // init models
    try {
      await this.sequelize.authenticate();
      console.log('Connection has been established successfully.');
    } catch (error) {
      console.error('Unable to connect to the database:', error);
    }
    await this.initializeModels();

    Controller.setRouter(this.router);
    await this.initializeControllers();
    this.router.addRoutes(this.config.routes);
    this.server.isInitialized = true;
  }

  async initializeModels() {
    await this.loadModels(this.config.service.MODELS_ROOT);
    await Promise.all(this.modelFinalizations.map((finalization) => finalization()));
    // TODO: Implement a migration strategy
    await this.sequelize.sync({ alter: { drop: false } });
  }

  async startServer() {
    await this.initialized;
    console.log("CONFIGURATION COMPLETE");
    return this.server.start(this.router);
  }

  async loadModels(absolutePath: string) {
    if (!fs.existsSync(absolutePath))
      return console.log('Cannot initialize. Path not found.', absolutePath);
    if (!fs.statSync(absolutePath).isFile()) {
      const directory_contents = fs.readdirSync(absolutePath);
      for (const rel_path of directory_contents) {
        await this.loadModels(path.join(absolutePath, rel_path));
      };
      return;
    }
    console.log('attempting to import Model:', absolutePath);
    // We just need to import each model once so the generateSuperclass
    // method is called at least once for each model.
    const modelModule = await import(absolutePath);
    // TODO: make sure the name isn't constantly "model"
    const modelClass = modelModule.default;
    if (!(modelClass.prototype instanceof Model)) {
      const errorMessage = `Default export is not a sequelize Model: ${absolutePath}`;
      console.error(errorMessage);
      throw errorMessage;
    }
    this.Models[modelClass.name] = modelClass as typeof Model;
    const schema = modelModule.schema;
    const options = modelModule.options;
    const defer = modelModule.defer as (() => Promise<void>) | undefined;
    const afterInitialize = modelModule.afterInitialize as (() => Promise<void>) | undefined;
    if (modelModule.finalize) {
      this.modelFinalizations.push(modelModule.finalize as () => Promise<void>);
    }
    if (modelModule.afterInitializeAll) {
      this.modelFinalizations.push(modelModule.afterInitializeAll as () => Promise<void>);
    }
    this.modelMigrations.push(modelModule.migrate as () => Promise<void>);

    modelClass.init(schema, { sequelize: this.sequelize, ...options });
    if (modelClass && modelClass.name) {
      console.log('imported model:', modelClass.name);
      if (defer) {
        await defer();
      }
      if (afterInitialize) {
        await afterInitialize();
      }
      await modelClass.sync();
    }
    else console.warn("No model found at:", absolutePath);
  }

  private async initializeControllers(directory?: string) {
    if (!directory) directory = this.config.service.CONTROLLERS_ROOT;
    console.log('attempting to import:', directory);
    if (!fs.existsSync(directory))
      return console.error('Cannot initialize. Path not found.', directory);
    if (fs.statSync(directory).isFile()) {
      let subclass = (await import(directory)).default;
      if (!(Controller.isPrototypeOf(subclass)))
        return console.error(`Non-Controller export "${subclass.name}: ${typeof subclass}" found: ${directory}`);
      const controller = new subclass();
      controller._registerControllerRoutes();
      return controller;
    }
    for (const rel_path of fs.readdirSync(directory)) {
      await this.initializeControllers(path.join(directory, rel_path));
    }
  }

}

// const sequelize = new Sequelize();