import PackageMetadata from "../PackageMetadata";
import SourcePackageGenerator from "../generators/SourcePackageGenerator";
import ManifestHelpers from "../manifest/ManifestHelpers";
import MDAPIPackageGenerator from "../generators/MDAPIPackageGenerator";
import { isNullOrUndefined } from "util";
import { EOL } from "os";

const fs = require("fs-extra");
import path = require("path");
import ApexTypeFetcher, { FileDescriptor } from "../parser/ApexTypeFetcher";
const Table = require("cli-table");
const xmlParser = require("xml2js").Parser({ explicitArray: false });

export default class CreateSourcePackageImpl {
  public constructor(
    private projectDirectory: string,
    private sfdx_package: string,
    private destructiveManifestFilePath: string,
    private packageArtifactMetadata: PackageMetadata
  ) {}

  public async exec(): Promise<PackageMetadata> {
    //Only set package type to source if its not provided, delta will be setting it up
    if (
      this.packageArtifactMetadata.package_type === null ||
      this.packageArtifactMetadata.package_type === undefined
    )
      this.packageArtifactMetadata.package_type = "source";

    console.log(
      "--------------Create Source Package---------------------------"
    );
    console.log("Project Directory", this.projectDirectory);
    console.log("sfdx_package", this.sfdx_package);
    console.log(
      "destructiveManifestFilePath",
      this.destructiveManifestFilePath
    );
    console.log("packageArtifactMetadata", this.packageArtifactMetadata);

    let startTime = Date.now();

    //Get Package Descriptor
    let packageDescriptor, packageDirectory: string;
    if (!isNullOrUndefined(this.sfdx_package)) {
      packageDescriptor = ManifestHelpers.getSFDXPackageDescriptor(
        this.projectDirectory,
        this.sfdx_package
      );
      packageDirectory = packageDescriptor["path"];
      this.packageArtifactMetadata.preDeploymentSteps = packageDescriptor[
        "preDeploymentSteps"
      ]?.split(",");
      this.packageArtifactMetadata.postDeploymentSteps = packageDescriptor[
        "postDeploymentSteps"
      ]?.split(",");
    }

    //Generate Destructive Manifest
    let destructiveChanges: DestructiveChanges = await this.getDestructiveChanges(
      packageDescriptor,
      this.destructiveManifestFilePath
    );
    if (!isNullOrUndefined(destructiveChanges)) {
      this.packageArtifactMetadata.isDestructiveChangesFound =
        destructiveChanges.isDestructiveChangesFound;
      this.packageArtifactMetadata.destructiveChanges =
        destructiveChanges.destructiveChanges;
    }

    //Convert to MDAPI to get PayLoad
    let mdapiPackage;
    if (!isNullOrUndefined(packageDirectory)) {
      //Check whether forceignores will result in empty directory
      let isEmpty: boolean = MDAPIPackageGenerator.isEmptyFolder(
        this.projectDirectory,
        packageDirectory
      );

      if (!isEmpty) {
        mdapiPackage = await MDAPIPackageGenerator.getMDAPIPackageFromSourceDirectory(
          this.projectDirectory,
          packageDirectory
        );

        this.packageArtifactMetadata.payload = mdapiPackage.manifest;
        this.packageArtifactMetadata.isApexFound = ManifestHelpers.checkApexInPayload(
          mdapiPackage.manifest
        );
        this.packageArtifactMetadata.isProfilesFound = ManifestHelpers.checkProfilesinPayload(
          mdapiPackage.manifest
        );

        this.handleApexTestClasses(mdapiPackage);

      } else {
        this.printEmptyArtifactWarning();
      }
    } else {
      console.log(
        "Proceeding with all packages.. as a particular package was not provided"
      );
    }

    //Get Artifact Detailes
    let sourcePackageArtifactDir = SourcePackageGenerator.generateSourcePackageArtifact(
      this.projectDirectory,
      this.sfdx_package,
      packageDirectory,
      isNullOrUndefined(destructiveChanges)
        ? undefined
        : destructiveChanges.destructiveChangesPath
    );

    this.packageArtifactMetadata.sourceDir = sourcePackageArtifactDir;

    //Add Timestamps
    let endTime = Date.now();
    let elapsedTime = endTime - startTime;
    this.packageArtifactMetadata.creation_details = {
      creation_time: elapsedTime,
      timestamp: Date.now(),
    };
    return this.packageArtifactMetadata;
  }

  private handleApexTestClasses(mdapiPackage: any) {
    let apexTypeFetcher: ApexTypeFetcher = new ApexTypeFetcher();
    let classTypes;
    try {
      classTypes = apexTypeFetcher.getApexTypeOfClsFiles(path.join(mdapiPackage.mdapiDir, `classes`));
    }
    catch (error) {
     return;
    }


    if (!this.packageArtifactMetadata.isTriggerAllTests) {
      if (this.packageArtifactMetadata.isApexFound &&
        (classTypes?.testClass?.length == 0)) {
        this.printSlowDeploymentWarning();
        this.packageArtifactMetadata.isTriggerAllTests = true;
      } else if (this.packageArtifactMetadata.isApexFound &&
        classTypes?.testClass?.length > 0) {
        if (classTypes?.parseError?.length > 0) {

          console.log(
            "---------------------------------------------------------------------------------------"
          );
          console.log("Unable to parse these classes to correctly identify test classes, Its not your issue, its ours! Please raise a issue in our repo!");
          this.printClassesIdentified(classTypes?.parseError);
          this.packageArtifactMetadata.isTriggerAllTests = true;
        }

        else {
          this.printHintForOptimizedDeployment();
          this.packageArtifactMetadata.isTriggerAllTests = false;
          this.printClassesIdentified(classTypes?.testClass);
          this.packageArtifactMetadata.apexTestClassses = [];
          classTypes?.testClass.forEach(element => {
            this.packageArtifactMetadata.apexTestClassses.push(element.name);
          });
        }
      }
    }
  }

  private printEmptyArtifactWarning() {
    console.log(
      "---------------------WARNING! Empty aritfact encountered-------------------------------"
    );
    console.log(
      "Either this folder is empty or the application of .forceignore results in an empty folder"
    );
    console.log("Proceeding to create an empty artifact");
    console.log(
      "---------------------------------------------------------------------------------------"
    );
  }

  private printHintForOptimizedDeployment() {
    console.log(`---------------- OPTION FOR DEPLOYMENT OPTIMIZATION AVAILABLE-----------------------------------`);
    console.log(`Following apex test classes were identified and can  be used for deploying this package,${EOL}` +
      `in an optimal manner, provided each individual class meets the test coverage requirement of 75% and above${EOL}` +
      `Ensure each apex class/trigger is validated for coverage in the validation stage`);
    console.log(`-----------------------------------------------------------------------------------------------`);
  }

  private printSlowDeploymentWarning() {
    console.log(`-------WARNING! YOU MIGHT NOT BE ABLE TO DEPLOY OR WILL HAVE A SLOW DEPLOYMENT---------------`);
    console.log(
      `This package has apex classes/triggers, however apex test classes were not found, You would not be able to deploy${EOL}` +
      `to production org optimally if each class do not have coverage of 75% and above,We will attempt deploying${EOL}` +
      `this package by triggering all local tests in the org which could be realy costly in terms of deployment time!${EOL}`
    );
    console.log(`---------------------------------------------------------------------------------------------`);
  }

  private  async getDestructiveChanges(
    packageDescriptor: any,
    destructiveManifestFilePath: string
  ): Promise<DestructiveChanges> {
    let destructiveChanges: any;
    let isDestructiveChangesFound: boolean = false;
    let destructiveChangesPath: string;

    if (packageDescriptor === null || packageDescriptor === undefined) {
      return undefined;
    }

    //Precedence to Value Passed in Flags
    if (!isNullOrUndefined(destructiveManifestFilePath)) {
      destructiveChangesPath = destructiveManifestFilePath;
    } else {
      if (packageDescriptor["destructiveChangePath"]) {
        destructiveChangesPath = packageDescriptor["destructiveChangePath"];
      }
    }

    try {
      if (!isNullOrUndefined(destructiveChangesPath)) {
        destructiveChanges = await CreateSourcePackageImpl.xml2json(destructiveChangesPath);
        isDestructiveChangesFound = true;
      }
    } catch (error) {
      console.log(
        "Unable to process destructive Manifest specified in the path or in the project manifest"
      );
      destructiveChangesPath = null;
    }

    return {
      isDestructiveChangesFound: isDestructiveChangesFound,
      destructiveChangesPath: destructiveChangesPath,
      destructiveChanges: destructiveChanges,
    };
  }

  private  printClassesIdentified(fetchedClasses:FileDescriptor[]) {


    if(fetchedClasses===null || fetchedClasses===undefined)
        return;

    let table = new Table({
      head: ["Class","Path", "Error"],
    });

    for (let fetchedClass of fetchedClasses) {
      let item = [fetchedClass.name, fetchedClass.filepath,fetchedClass.error?fetchedClass.error:"N/A"];
      table.push(item);
    }
    console.log("Following apex test classes were identified");
    console.log(table.toString());
  }

  private static xml2json(xml) {
    return new Promise((resolve, reject) => {
      xmlParser.parseString(xml, function (err, json) {
        if (err) reject(err);
        else resolve(json);
      });
    });
  }

}
type DestructiveChanges = {
  isDestructiveChangesFound: boolean;
  destructiveChangesPath: string;
  destructiveChanges: any;
};
