import ArtifactGenerator from "@dxatscale/sfpowerscripts.core/lib/generators/ArtifactGenerator";

import { EOL } from "os";
import { flags } from "@salesforce/command";
import SfpowerscriptsCommand from "./SfpowerscriptsCommand";
import { Messages } from "@salesforce/core";
import { exec } from "shelljs";
import fs = require("fs");
import SFPStatsSender from "@dxatscale/sfpowerscripts.core/lib/utils/SFPStatsSender";
import BuildImpl from "./impl/parallelBuilder/BuildImpl";
import { Stage } from "./impl/Stage";

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages("@dxatscale/sfpowerscripts", "build");

export default abstract class BuildBase extends SfpowerscriptsCommand {
 


  protected static requiresUsername = false;
  protected static requiresDevhubUsername = true;
  protected static requiresProject = true;
  

  protected static flagsConfig = {
    diffcheck: flags.boolean({
      description: messages.getMessage("diffCheckFlagDescription"),
      default: false
    }),
    gittag: flags.boolean({
      description: messages.getMessage("gitTagFlagDescription"),
      default: false,
    }),
    repourl: flags.string({
      char: "r",
      description: messages.getMessage("repoUrlFlagDescription"),
    }),
    configfilepath: flags.filepath({
      char: "f",
      description: messages.getMessage("configFilePathFlagDescription"),
      default: "config/project-scratch-def.json",
    }),
    artifactdir: flags.directory({
      description: messages.getMessage("artifactDirectoryFlagDescription"),
      default: "artifacts",
    }),
    waittime: flags.number({
      description: messages.getMessage("waitTimeFlagDescription"),
      default: 120,
    }),
    buildnumber: flags.number({
      description: messages.getMessage("buildNumberFlagDescription"),
      default: 1,
    }),
    executorcount: flags.number({
      description: messages.getMessage("executorCountFlagDescription"),
      default: 5,
    }),
    branch:flags.string({
      description:messages.getMessage("branchFlagDescription"),
    }),
    tag:flags.string({
      description:messages.getMessage("tagFlagDescription"),
    })
  };

  
  public async execute() {
    try {
      const artifactDirectory: string = this.flags.artifactdir;
      const gittag: boolean = this.flags.gittag;
      const diffcheck: boolean = this.flags.diffcheck;
      const branch:string=this.flags.branch;


      console.log("-----------sfpowerscripts orchestrator ------------------");
      console.log(`command: ${this.getStage()}`);
      console.log(`Build Packages Only Changed: ${this.flags.diffcheck}`);
      console.log(`Config File Path: ${this.flags.configfilepath}`);
      console.log(`Artifact Directory: ${this.flags.artifactdir}`);
      console.log("---------------------------------------------------------");
  
  

      await this.hubOrg.refreshAuth();
     


      let executionStartTime = Date.now();

      let { generatedPackages, failedPackages } = await this.getBuildImplementer().exec();

      if (
        diffcheck &&
        generatedPackages.length == 0 &&
        failedPackages.length == 0
      ) {
        console.log(`${EOL}${EOL}`);
        console.log("No packages found to be built.. .. ");
        return;
      }

      console.log(`${EOL}${EOL}`);
      console.log("Generating Artifacts and Tags....");

      const buildResult: BuildResult = {
        packages: [],
        summary: {
          scheduled_packages: null,
          elapsed_time: null,
          succeeded: null,
          failed: null
        }
      };

      for (let generatedPackage of generatedPackages) {
        try {
          await ArtifactGenerator.generateArtifact(
            generatedPackage.package_name,
            process.cwd(),
            artifactDirectory,
            generatedPackage
          );


          buildResult["packages"].push({
            name: generatedPackage["package_name"],
            version: generatedPackage["package_version_number"],
            elapsed_time: generatedPackage["creation_details"]?.creation_time,
            status: "succeeded"
          });


          if (gittag) {
            exec(`git config --global user.email "sfpowerscripts@dxscale"`);
            exec(`git config --global user.name "sfpowerscripts"`);

            let tagname = `${generatedPackage.package_name}_v${generatedPackage.package_version_number}`;
            exec(
              `git tag -a -m "${generatedPackage.package_name} ${generatedPackage.package_type} Package ${generatedPackage.package_version_number}" ${tagname} HEAD`,
              { silent: false }
            );
          }
        } catch (error) {
          console.log(
            `Unable to create artifact or tag for ${generatedPackage.package_name}`
          );
          console.log(error);
        }
      }

      for (let failedPackage of failedPackages) {
        buildResult["packages"].push({
          name: failedPackage,
          version: null,
          elapsed_time: null,
          status: "failed"
        })
      }

      let totalElapsedTime: number = Date.now() - executionStartTime;
      buildResult["summary"].scheduled_packages = generatedPackages.length + failedPackages.length;
      buildResult["summary"].elapsed_time = totalElapsedTime;
      buildResult["summary"].succeeded = generatedPackages.length;
      buildResult["summary"].failed = failedPackages.length;

      fs.writeFileSync(`buildResult.json`, JSON.stringify(buildResult, null, 4));

      let tags = {
        is_diffcheck_enabled: String(diffcheck),
        stage: this.getStage(),
        branch: branch
      };

     if(!(this.flags.tag==null || this.flags.tag==undefined))
     {
       tags["tag"]=this.flags.tag;
     }

      console.log("Sending Metrics if enabled..",tags);
      SFPStatsSender.logGauge(
        "build.duration",
        (Date.now() - executionStartTime),
        tags
      );

      console.log(
        `----------------------------------------------------------------------------------------------------`
      );
      console.log(
        `${
          generatedPackages.length
        } packages created in ${this.getFormattedTime(
          totalElapsedTime
        )} minutes with {${failedPackages.length}} errors`
      );



      if (failedPackages.length > 0) {
        console.log(`Packages Failed To Build`, failedPackages);
      }
      console.log(
        `----------------------------------------------------------------------------------------------------`
      );

      if (failedPackages.length > 0) {
       process.exitCode=1;
      }
    } catch (error) {
      console.log(error);
      process.exitCode=1;
    }
  }
  
  abstract getStage():Stage;

  private getFormattedTime(milliseconds: number): string {
    let date = new Date(0);
    date.setSeconds(milliseconds / 1000); // specify value for SECONDS here
    let timeString = date.toISOString().substr(11, 8);
    return timeString;
  }

  abstract getBuildImplementer():BuildImpl;
}

interface BuildResult {
  packages: {
    name: string,
    version: string,
    elapsed_time: number,
    status: string
  }[],
  summary: {
    scheduled_packages: number,
    elapsed_time: number,
    succeeded: number,
    failed: number
  }
}
