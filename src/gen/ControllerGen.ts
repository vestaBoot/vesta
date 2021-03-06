import { FieldType, IModelFields } from "@vesta/core";
import { readFileSync } from "fs";
import { camelCase } from "lodash";
import { join } from "path";
import { ArgParser } from "../util/ArgParser";
import { genRelativePath, mkdir, writeFile } from "../util/FsUtil";
import { Log } from "../util/Log";
import { getConfidentialFields, getFieldMeta, getFieldsByType, getOwnerVerifiedFields } from "../util/Model";
import { pascalCase, plural } from "../util/StringUtil";
import { ClassGen } from "./core/ClassGen";
import { MethodGen } from "./core/MethodGen";
import { Placeholder } from "./core/Placeholder";
import { Access } from "./core/StructureGen";
import { TsFileGen } from "./core/TSFileGen";
import { Vesta } from "./Vesta";

export interface IControllerConfig {
  model: string;
  name: string;
  route: string;
  version: string;
}

export class ControllerGen {
  public static help() {
    Log.write(`
Usage: vesta gen controller <NAME> [options...]

Creating a server side (Vesta API) controller

    NAME        The name of the controller

Options:
    --model     Generates CRUD controller for specified model
    --route     Routing path
    --version   api version [v1]

Examples:
    vesta gen controller simple
    vesta gen controller profile --model=User --route=account
`);
  }

  public static init(): IControllerConfig {
    const argParser = ArgParser.getInstance();
    const config: IControllerConfig = {
      model: argParser.get("--model", null),
      name: argParser.get(),
      route: argParser.get("--route", "/"),
      version: argParser.get("--version", "v1"),
    };

    if (!config.name || !/^[a-z]+$/i.exec(config.name)) {
      Log.error("Missing/Invalid controller name\nSee 'vesta gen controller --help' for more information\n");
      return;
    }
    // this happens in case of `vesta gen controller name --model User` without =
    if (config.model.toString() === "true") {
      Log.error("Missing/Invalid model name\nSee 'vesta gen controller --help' for more information\n");
      return;
    }

    const controller = new ControllerGen(config);
    controller.generate();
  }

  private apiVersion: string;
  private confidentialFields: string[] = [];
  private controllerClass: ClassGen;
  private controllerFile: TsFileGen;
  private filesFields: IModelFields = null;
  private ownerVerifiedFields: string[] = [];
  private path: string = "src/api";
  private rawName: string;
  private relationsFields: IModelFields = null;
  private routeMethod: MethodGen;
  private routingPath: string = "/";
  private vesta: Vesta;

  constructor(private config: IControllerConfig) {
    this.apiVersion = config.version;
    this.init();
  }

  public generate() {
    if (this.config.model) {
      this.addCRUDOperations();
    }
    writeFile(join(this.path, `${this.controllerClass.name}.ts`), this.controllerFile.generate());
    const filePath = `src/api/${this.apiVersion}/import.ts`;
    let code = readFileSync(filePath, { encoding: "utf8" });
    if (code.search(Placeholder.ExpressController)) {
      const relPath = genRelativePath(`src/api/${this.apiVersion}`, this.path);
      const importCode = `import {${this.controllerClass.name}} from "${relPath}/${this.controllerClass.name}";`;
      if (code.indexOf(importCode) >= 0) {
        return;
      }
      const embedCode = `${camelCase(this.config.name)}: ${this.controllerClass.name},`;
      code = code.replace(Placeholder.Import, `${importCode}\n${Placeholder.Import}`);
      code = code.replace(Placeholder.ExpressController, `${embedCode}\n\t\t${Placeholder.ExpressController}`);
      writeFile(filePath, code);
    }
  }

  private init() {
    this.path = join(this.path, this.apiVersion, "controller", this.config.route);
    this.rawName = camelCase(this.config.name);
    const controllerName = pascalCase(this.rawName) + "Controller";
    this.normalizeRoutingPath();
    this.controllerFile = new TsFileGen(controllerName);
    this.controllerClass = this.controllerFile.addClass();
    this.controllerClass.shouldExport(true);
    if (this.config.model) {
      this.filesFields = getFieldsByType(this.config.model, FieldType.File);
    }
    if (this.filesFields) {
      this.controllerFile.addImport(["join"], "path");
    }
    this.controllerFile.addImport(["NextFunction", "Response", "Router"], "express");
    this.controllerFile.addImport(["BaseController", "IExtRequest"], genRelativePath(this.path, "src/api/BaseController"));
    this.controllerClass.setParentClass("BaseController");
    this.routeMethod = this.controllerClass.addMethod({ name: "route", access: Access.Public });
    this.routeMethod.addParameter({ name: "router", type: "Router" });
    // this.controllerClass.addMethod('init', ClassGen.Access.Protected);
    mkdir(this.path);
  }

  private addResponseMethod(name: string) {
    const method = this.controllerClass.addMethod({ name, access: Access.Private, isAsync: true });
    method.addParameter({ name: "req", type: "IExtRequest" });
    method.addParameter({ name: "res", type: "Response" });
    method.addParameter({ name: "next", type: "NextFunction" });
    // method.appendContent(`return next({message: '${name} has not been implemented'})`);
    return method;
  }

  private addCRUDOperations() {
    const modelName = pascalCase(this.config.model);
    const modelInstanceName = camelCase(modelName);
    const modelClassName = pascalCase(modelInstanceName);
    this.relationsFields = getFieldsByType(this.config.model, FieldType.Relation);
    this.ownerVerifiedFields = getOwnerVerifiedFields(this.config.model);
    this.confidentialFields = getConfidentialFields(this.config.model);
    this.controllerFile.addImport(["Err", "DatabaseError", "ValidationError"], "@vesta/core");
    this.controllerFile.addImport([modelClassName, `I${modelClassName}`], genRelativePath(this.path, `src/cmn/models/${this.config.model}`));
    this.controllerFile.addImport(["AclAction"], "@vesta/services");
    let acl = this.routingPath.replace(/\/+/g, ".");
    acl = acl[0] === "." ? acl.slice(1) : acl;
    const middleWares = ` this.checkAcl("${acl}", __ACTION__),`;
    // count operation
    let methodName = `get${modelClassName}Count`;
    let methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Read");
    this.addResponseMethod(methodName).appendContent(this.getCountCode());
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.get("${this.routingPath}/count",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    //
    methodName = "get" + modelClassName;
    methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Read");
    this.addResponseMethod(methodName).appendContent(this.getQueryCode(true));
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.get("${this.routingPath}/:id",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    //
    methodName = "get" + plural(modelClassName);
    this.addResponseMethod(methodName).appendContent(this.getQueryCode(false));
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.get("${this.routingPath}",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    //
    methodName = "add" + modelClassName;
    methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Add");
    this.addResponseMethod(methodName).appendContent(this.getInsertCode());
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.post("${this.routingPath}",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    //
    methodName = "update" + modelClassName;
    methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Edit");
    this.addResponseMethod(methodName).appendContent(this.getUpdateCode());
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.put("${this.routingPath}",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    //
    methodName = "remove" + modelClassName;
    methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Delete");
    this.addResponseMethod(methodName).appendContent(this.getDeleteCode());
    // tslint:disable-next-line:max-line-length
    this.routeMethod.appendContent(`router.delete("${this.routingPath}/:id",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    // file upload
    if (this.filesFields) {
      methodName = "upload";
      methodBasedMiddleWares = middleWares.replace("__ACTION__", "AclAction.Edit");
      this.addResponseMethod(methodName).appendContent(this.getUploadCode());
      // tslint:disable-next-line:max-line-length
      this.routeMethod.appendContent(`router.post("${this.routingPath}/file/:id",${methodBasedMiddleWares} this.wrap(this.${methodName}));`);
    }
  }

  private normalizeRoutingPath(): void {
    const edge = camelCase(this.config.name);
    this.routingPath = `${this.config.route}`;
    if (this.routingPath.charAt(0) !== "/") {
      this.routingPath = `/${this.routingPath}`;
    }
    this.routingPath += `/${edge}`;
    this.routingPath = this.routingPath.replace(/\/{2,}/g, "/");
  }

  private getAuthUserCode(): string {
    return this.ownerVerifiedFields.length
      ? `const authUser = this.getUserFromSession(req);
        const isAdmin = this.isAdmin(authUser);\n\t\t`
      : "";
  }

  private getConfFieldRemovingCode(singleRecord?: boolean): string {
    const confRemovers = [];
    const index = singleRecord ? "0" : "i";
    if (!this.confidentialFields.length) {
      for (let i = this.confidentialFields.length; i--; ) {
        confRemovers.push(`delete result.items[${index}].${this.confidentialFields[i]};`);
      }
    }
    // checking confidentiality of relations
    if (this.relationsFields) {
      const relationFieldsNames = Object.keys(this.relationsFields);
      for (let i = relationFieldsNames.length; i--; ) {
        const meta = getFieldMeta(this.config.model, relationFieldsNames[i]);
        const extPath = meta.relation.path ? `/${meta.relation.path}` : "";
        const relConfFields = getConfidentialFields(meta.relation.model);
        if (relConfFields.length) {
          this.controllerFile.addImport([`I${meta.relation.model}`], genRelativePath(this.path, `src/cmn/models${extPath}/${meta.relation.model}`));
          for (let j = relConfFields.length; j--; ) {
            // tslint:disable-next-line:max-line-length
            confRemovers.push(`delete (result.items[${index}].${relationFieldsNames[i]} as I${meta.relation.model}).${relConfFields[j]};`);
          }
        }
      }
    }
    let code = "";
    if (confRemovers.length) {
      if (singleRecord) {
        code = `\n\t\t${confRemovers.join("\n\t\t")}`;
      } else {
        code = `\n\t\tfor (let i = result.items.length; i--;) {
            ${confRemovers.join("\n\t\t\t")}
        }`;
      }
    }
    return code;
  }

  private getQueryCodeForSingleInstance(): string {
    const modelName = pascalCase(this.config.model);
    const ownerChecks = [];
    for (let i = this.ownerVerifiedFields.length; i--; ) {
      const meta = getFieldMeta(this.config.model, this.ownerVerifiedFields[i]);
      if (meta.relation) {
        const extPath = meta.relation.path ? `/${meta.relation.path}` : "";
        this.controllerFile.addImport([`I${meta.relation.model}`], genRelativePath(this.path, `src/cmn/models${extPath}/${meta.relation.model}`));
        // tslint:disable-next-line:max-line-length
        ownerChecks.push(`(result.items[0].${this.ownerVerifiedFields} as I${meta.relation.model}).id !== authUser.id`);
      } else {
        ownerChecks.push(`result.items[0].${this.ownerVerifiedFields} !== authUser.id`);
      }
    }
    const ownerCheckCode = ownerChecks.length ? ` || (!isAdmin && (${ownerChecks.join(" || ")}))` : "";
    const relationFields = this.relationsFields ? `, { relations: ["${Object.keys(this.relationsFields).join(`", "`)}"] }` : "";
    return `${this.getAuthUserCode()}const id = this.retrieveId(req);
        const result = await ${modelName}.find<I${modelName}>(id${relationFields});
        if (!result.items.length${ownerCheckCode}) {
            throw new DatabaseError(Err.Code.DBNoRecord, null);
        }${this.getConfFieldRemovingCode(true)}
        res.json(result);`;
  }

  private getQueryCodeForMultiInstance(): string {
    const modelName = pascalCase(this.config.model);
    const ownerQueries = [];
    for (let i = this.ownerVerifiedFields.length; i--; ) {
      ownerQueries.push(`${this.ownerVerifiedFields[i]}: authUser.id`);
    }
    const ownerQueriesCode = ownerQueries.length
      ? `\n\t\tif (!isAdmin) {
            query.filter({${ownerQueries.join(", ")}});
        }`
      : "";
    return `${this.getAuthUserCode()}const query = this.query2vql(${modelName}, req.query);${ownerQueriesCode}
        const result = await ${modelName}.find<I${modelName}>(query);${this.getConfFieldRemovingCode()}
        res.json(result);`;
  }

  private getCountCode(): string {
    const modelName = pascalCase(this.config.model);
    // let modelInstanceName = camelCase(modelName);
    return `const query = this.query2vql(${modelName}, req.query, true);
        const result = await ${modelName}.count<I${modelName}>(query);
        res.json(result);`;
  }

  private getQueryCode(isSingle: boolean): string {
    return isSingle ? this.getQueryCodeForSingleInstance() : this.getQueryCodeForMultiInstance();
  }

  private getInsertCode(): string {
    const modelName = pascalCase(this.config.model);
    const modelInstanceName = camelCase(modelName);
    const ownerAssigns = [];
    for (let i = this.ownerVerifiedFields.length; i--; ) {
      ownerAssigns.push(`${modelInstanceName}.${this.ownerVerifiedFields[i]} = authUser.id;`);
    }
    const ownerAssignCode = ownerAssigns.length
      ? `\n\t\tif (!isAdmin) {
            ${ownerAssigns.join("\n\t\t")}
        }`
      : "";
    return `${this.getAuthUserCode()}const ${modelInstanceName} = new ${modelName}(req.body);${ownerAssignCode}
        const validationError = ${modelInstanceName}.validate();
        if (validationError) {
            throw new ValidationError(validationError);
        }
        const result = await ${modelInstanceName}.insert<I${modelName}>();${this.getConfFieldRemovingCode(true)}
        res.json(result);`;
  }

  private getUpdateCode(): string {
    const modelName = pascalCase(this.config.model);
    const modelInstanceName = camelCase(modelName);
    const ownerChecks = [];
    const ownerInlineChecks = [];
    for (let i = this.ownerVerifiedFields.length; i--; ) {
      ownerChecks.push(`${modelInstanceName}.${this.ownerVerifiedFields[i]} = authUser.id;`);
      // check owner of record after finding the record based on recordId
      ownerInlineChecks.push(`${modelInstanceName}.${this.ownerVerifiedFields[i]} !== authUser.id`);
    }
    const ownerCheckCode = ownerChecks.length ? `\n\t\tif (!isAdmin) {\n\t\t\t${ownerChecks.join("\n\t\t\t")}\n\t\t}` : "";
    const ownerCheckInlineCode = ownerInlineChecks.length ? ` || (!isAdmin && (${ownerInlineChecks.join(" || ")}))` : "";
    return `${this.getAuthUserCode()}const ${modelInstanceName} = new ${modelName}(req.body);${ownerCheckCode}
        const validationError = ${modelInstanceName}.validate();
        if (validationError) {
            throw new ValidationError(validationError);
        }
        const result = await ${modelName}.find<I${modelName}>(${modelInstanceName}.id);
        if (!result.items.length${ownerCheckInlineCode}) {
            throw new DatabaseError(Err.Code.DBNoRecord, null);
        }
        const uResult = await ${modelInstanceName}.update<I${modelName}>();${this.getConfFieldRemovingCode(true)}
        res.json(uResult);`;
  }

  private getDeleteCode(): string {
    const modelName = pascalCase(this.config.model);
    const modelInstanceName = camelCase(modelName);
    const ownerChecks = [];
    if (this.ownerVerifiedFields.length) {
      for (let i = this.ownerVerifiedFields.length; i--; ) {
        ownerChecks.push(`result.items[0].${this.ownerVerifiedFields} !== authUser.id`);
      }
    }
    const fieldsOfTypeFile = getFieldsByType(modelName, FieldType.File);
    let deleteFileCode = [];

    if (fieldsOfTypeFile) {
      this.controllerFile.addImport(["LogLevel"], "@vesta/services");
      // tslint:disable-next-line:max-line-length
      deleteFileCode = ["\n\t\tconst filesToBeDeleted = [];", `const baseDirectory = \`\${this.config.dir.upload}/${modelInstanceName}\`;`];
      for (let fields = Object.keys(fieldsOfTypeFile), i = 0, il = fields.length; i < il; i++) {
        const field = fieldsOfTypeFile[fields[i]];
        if (field.properties.type === FieldType.List) {
          deleteFileCode.push(`if (${modelInstanceName}.${field.fieldName}) {
            for (let i = ${modelInstanceName}.${field.fieldName}.length; i--; ) {
                filesToBeDeleted.push(\'\${baseDirectory}/\${${modelInstanceName}.${field.fieldName}[i]}\');
            }
        }`);
        } else {
          // tslint:disable-next-line:max-line-length
          deleteFileCode.push(`filesToBeDeleted.push(\`\${baseDirectory}/\${${modelInstanceName}.${field.fieldName}}\`);`);
        }
      }
      deleteFileCode.push(`for (let i = filesToBeDeleted.length; i--;) {
            try {
                await FileUploader.checkAndDeleteFile(filesToBeDeleted[i]);
            } catch (error) {
                req.log(LogLevel.Warning, error.message, "remove${modelName}", "${modelName}Controller");
            }
        }`);
    }
    const ownerCheckCode = ownerChecks.length
      ? `
        if (!isAdmin && (!result.items.length || ${ownerChecks.join(" || ")})) {
            throw new DatabaseError(Err.Code.DBNoRecord, null);
        }`
      : "";
    return `${this.getAuthUserCode()}const id = this.retrieveId(req);
        const result = await ${modelName}.find<I${modelName}>(id);${ownerCheckCode}
        const ${modelInstanceName} = new ${modelName}(result.items[0]);${deleteFileCode.join("\n\t\t")}
        const dResult = await ${modelInstanceName}.remove();
        res.json(dResult);`;
  }

  private getUploadCode(): string {
    // todo add conf & owner
    this.controllerFile.addImport(["FileUploader"], genRelativePath(this.path, "src/helpers/FileUploader"));
    const modelName = pascalCase(this.config.model);
    const modelInstanceName = camelCase(modelName);
    let code = "";
    const fileNames = Object.keys(this.filesFields);
    if (fileNames.length === 1) {
      code = `const oldFileName = ${modelInstanceName}.${fileNames[0]};
        ${modelInstanceName}.${fileNames[0]} = upl.${fileNames[0]};
        if (oldFileName) {
            await FileUploader.checkAndDeleteFile(\`\${destDirectory}/\${oldFileName}\`);
        }`;
    } else {
      code = `const delList: Array<Promise<string>> = [];`;
      for (let i = 0, il = fileNames.length; i < il; ++i) {
        const oldName = `old${pascalCase(fileNames[i])}`;
        code += `
        if (upl.${fileNames[i]}) {
            const ${oldName} = ${modelInstanceName}.${fileNames[i]};
            delList.push(FileUploader.checkAndDeleteFile(\`\${destDirectory}/\${${oldName}}\`)
                .then(() => ${modelInstanceName}.${fileNames[i]} = upl.${fileNames[i]} as string));
        }`;
      }
      code += `
        await Promise.all(delList);`;
    }
    return `const id = this.retrieveId(req);
        const destDirectory = join(this.config.dir.upload, "${modelInstanceName}");
        const result = await ${modelName}.find<I${modelName}>(id);
        if (result.items.length !== 1) {
            throw new Err(Err.Code.DBRecordCount, "${modelName} not found");
        }
        const ${modelInstanceName} = new ${modelName}(result.items[0]);
        const uploader = new FileUploader<I${modelName}>(true);
        await uploader.parse(req);
        const upl = await uploader.upload(destDirectory);
        ${code}
        const uResult = await ${modelInstanceName}.update();
        res.json(uResult);`;
  }
}
