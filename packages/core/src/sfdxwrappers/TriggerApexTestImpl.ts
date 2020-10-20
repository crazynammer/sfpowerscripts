import child_process = require("child_process");
import { onExit } from "../utils/OnExit";
import { isNullOrUndefined } from "util";
import fs = require("fs-extra");
import path = require("path");
import MDAPIPackageGenerator from "../generators/MDAPIPackageGenerator";
import ApexTypeFetcher, { ApexSortedByType } from "../parser/ApexTypeFetcher";
import ManifestHelpers from "../manifest/ManifestHelpers";
const Table = require("cli-table");

export default class TriggerApexTestImpl {
  private packageDescriptor;
  private apexSortedByType: ApexSortedByType;

  public constructor(
    private target_org: string,
    private test_options: any,
    private project_directory: string,
  ) {}

  public async exec(): Promise<{
    id: string;
    result: boolean;
    message: string;
  }> {

    const test_result: { id: string; result: boolean; message: string } = {
      id: "",
      result: false,
      message: ""
    };

    let output = "";
    let error = ""
    try {
      //Print final output
      let child = child_process.exec(
        this.buildExecCommand(),
        {
          maxBuffer: 1024 * 1024 * 5,
          encoding: "utf8"
        },
        (error, stdout, stderr) => {}
      );

      child.stdout.on("data", data => {
        output += data.toString();
      });
      child.stderr.on("data", data => {
        error += data.toString();
      });

      await onExit(child);

    } catch (err) {
        if (
          err.message === "Package or package directory does not exist" ||
          err.message === "No test classes found in package"
        ) {
          // Terminate execution without running command
          test_result.result = false;
          test_result.message = err.message;
          return test_result;
        }
    } finally {
      console.log(output);
    }

    let test_report_json;
    try {
      let test_id = fs
        .readFileSync(
          path.join(this.test_options["outputdir"], "test-run-id.txt")
        )
        .toString();

      console.log('test_id',test_id);
      test_result.id = test_id;

      let test_report_json_file = fs
        .readFileSync(
          path.join(
            this.test_options["outputdir"],
            `test-result-${test_id}.json`
          )
        )
        .toString();

      test_report_json = JSON.parse(test_report_json_file);

      //Print human readable output to console
      if ((test_report_json.summary.outcome == "Failed")) {
        test_result.message = `${test_report_json.summary.failing} Tests failed with overall Test Run Coverage of ${test_report_json.summary.testRunCoverage}`;
        test_result.message += "\nFailed Test Cases:";

        test_report_json.tests.forEach(element => {
          if (element.Outcome == "Fail") {
            test_result.message += "\n"+ `${element.MethodName}  ${element.Message}    ${element.StackTrace}`;
          }
        });
        test_result.result = false;
        return test_result;
      }
    } catch (err) {
      test_result.result = false;
      test_result.message = error;
      return test_result;
    }

    let classesWithInvalidCoverage: {name: string, coveredPercent: number}[];

    if (this.test_options["isValidateCoverage"]) {
      classesWithInvalidCoverage = await this.validateClassCodeCoverage();
    }

    if (isNullOrUndefined(classesWithInvalidCoverage) || classesWithInvalidCoverage.length === 0) {
      test_result.message = `${test_report_json.summary.passing} Tests passed with overall Test Run Coverage of ${test_report_json.summary.testRunCoverage} percent`;
      test_result.result = true;
    } else {
      test_result.message=`There are classes that do not satisfy the minimum code coverage of ${this.test_options["coverageThreshold"]}%`;
      test_result.result = false;

      this.printClassesWithInvalidCoverage(classesWithInvalidCoverage);
    }
    return test_result;
  }

  private buildExecCommand(): string {
    let command = `npx sfdx force:apex:test:run -u ${this.target_org}`;

    if (this.test_options["synchronous"] == true) command += ` -y`;

    command += ` -c`;

    command += ` -r human`;
    //wait time
    command += ` -w  ${this.test_options["wait_time"]}`;

    //store result
    command += ` -d  ${this.test_options["outputdir"]}`;

    //testlevel
    // allowed options: RunLocalTests, RunAllTestsInOrg, RunSpecifiedTests, RunAllTestsInPackage
    if (this.test_options["testlevel"] !== "RunApexTestSuite") {
      if (this.test_options["testlevel"] === "RunAllTestsInPackage") {
        command += ` -l RunSpecifiedTests`;
      } else {
        command += ` -l ${this.test_options["testlevel"]}`;
      }
    }

    if (this.test_options["testlevel"] == "RunSpecifiedTests") {
      command += ` -t ${this.test_options["specified_tests"]}`;
    } else if (this.test_options["testlevel"] === "RunAllTestsInPackage") {
      // Get name of test classes in package directory
      this.packageDescriptor = ManifestHelpers.getSFDXPackageDescriptor(
        this.project_directory,
        this.test_options["package"]
      );

      let apexTypeFetcher: ApexTypeFetcher = new ApexTypeFetcher();
      this.apexSortedByType =  apexTypeFetcher.getApexTypeOfClsFiles(this.packageDescriptor["path"]);

      let testClassNames: string[] = this.apexSortedByType["testClass"].map( (fileDescriptor) =>
        fileDescriptor.name
      );

      if (testClassNames.length === 0) {
        throw new Error("No test classes found in package");
      }

      command += ` -t ${testClassNames.toString()}`;
    }
    else if (this.test_options["testlevel"] == "RunApexTestSuite") {
      command += ` -s ${this.test_options["apextestsuite"]}`;
    }

    console.log(`Generated Command: ${command}`);
    return command;
  }

  private async validateClassCodeCoverage(): Promise<{name: string, coveredPercent: number}[]>  {
    console.log(`Validating individual classes for code coverage greater than ${this.test_options["coverageThreshold"]} percent`);
    let classesWithInvalidCoverage: {name: string, coveredPercent: number}[] = [];

    let mdapiPackage: {mdapiDir: string, manifest} = await MDAPIPackageGenerator.getMDAPIPackageFromSourceDirectory(
      this.project_directory,
      this.packageDescriptor["path"]
    );

    let packageClasses: string[] = this.getClassesFromPackageManifest(mdapiPackage);
    let triggers: string[] = this.getTriggersFromPackageManifest(mdapiPackage);

    let code_coverage = fs.readFileSync(
      path.join(
        this.test_options["outputdir"],
        `test-result-codecoverage.json`
      ),
      "utf8"
    );

    let code_coverage_json = JSON.parse(code_coverage);
    code_coverage_json = this.filterCodeCoverageToPackageClasses(code_coverage_json, packageClasses, triggers);

    // Check code coverage of package classes that have test classes
    for (let classCoverage of code_coverage_json) {
      if (
        classCoverage["coveredPercent"] !== null &&
        classCoverage["coveredPercent"] < this.test_options["coverageThreshold"]
      ) {
        classesWithInvalidCoverage.push({name: classCoverage["name"], coveredPercent: classCoverage["coveredPercent"]});
      }
    }

    // Check for package classes with no test class
    let namesOfClassesWithoutTest: string[] = packageClasses.filter( (packageClass) => {
      // Filter out package class if accounted for in coverage json
      for (let classCoverage of code_coverage_json) {
        if (classCoverage["name"] === packageClass) {
          return false;
        }
      }
      return true;
    });


    if (namesOfClassesWithoutTest.length > 0) {
      let classesWithoutTest: {name: string, coveredPercent: number}[] = namesOfClassesWithoutTest.map(
        (className) => {
        return {name: className, coveredPercent: 0};
      });
      classesWithInvalidCoverage = classesWithInvalidCoverage.concat(classesWithoutTest);
    }

    if (triggers != null) {
      // Check for triggers with no test class
      let namesOfTriggersWithoutTest: string[] = triggers.filter( (trigger) => {
        // Filter out triggers if accounted for in coverage json
        for (let classCoverage of code_coverage_json) {
          if (classCoverage["name"] === trigger) {
            return false
          }
        }
        return true
      });

      if (namesOfTriggersWithoutTest.length > 0) {
        let triggersWithoutTest: {name: string, coveredPercent: number}[] = namesOfTriggersWithoutTest.map(
          (triggerName) => {
            return {name: triggerName, coveredPercent: 0};
          });
        classesWithInvalidCoverage = classesWithInvalidCoverage.concat(triggersWithoutTest);
      }
    }

    return classesWithInvalidCoverage;
  }

  /**
   * Filter code coverage to classes and triggers in the package
   * @param codeCoverage
   * @param packageClasses
   * @param triggers
   */
  private filterCodeCoverageToPackageClasses(codeCoverage, packageClasses: string[], triggers: string[]) {
    let filteredCodeCoverage = codeCoverage.filter( (classCoverage) => {
      if (packageClasses != null) {
        for (let packageClass of packageClasses) {
          if (packageClass === classCoverage["name"])
            return true;
        }
      }

      if (triggers != null) {
        for (let trigger of triggers) {
          if (trigger === classCoverage["name"]) {
            return true
          }
        }
      }

      return false;
    });

    return filteredCodeCoverage;
  }
  private getTriggersFromPackageManifest(mdapiPackage: {mdapiDir: string, manifest}): string[] {
    let triggers: string[];

    let types;
    if (mdapiPackage.manifest["Package"]["types"] instanceof Array) {
      types = mdapiPackage.manifest["Package"]["types"];
    } else {
      // Create array with single type
      types = [mdapiPackage.manifest["Package"]["types"]];
    }

    for (let type of types) {
      if (type["name"] === "ApexTrigger") {
        if (type["members"] instanceof Array) {
          triggers = type["members"];
        } else {
          // Create array with single member
          triggers = [type["members"]];
        }
        break;
      }
    }

    return triggers;
  }

  private getClassesFromPackageManifest(mdapiPackage: {mdapiDir: string, manifest}): string[] {
    let packageClasses: string[];

    let types;
    if (mdapiPackage.manifest["Package"]["types"] instanceof Array) {
      types = mdapiPackage.manifest["Package"]["types"];
    } else {
      // Create array with single type
      types = [mdapiPackage.manifest["Package"]["types"]];
    }

    for (let type of types) {
      if (type["name"] === "ApexClass") {
        if (type["members"] instanceof Array) {
          packageClasses = type["members"];
        } else {
          // Create array with single member
          packageClasses = [type["members"]];
        }
        break;
      }
    }

    if (packageClasses != null) {

      if (this.apexSortedByType["testClass"].length > 0) {
        // Filter out test classes
        packageClasses = packageClasses.filter( (packageClass) => {
          for (let testClass of this.apexSortedByType["testClass"]) {
            if (testClass["name"] === packageClass) {
              return false;
            }
          }

          if (this.apexSortedByType["parseError"].length > 0) {
            // Filter out undetermined classes that failed to parse
            for (let parseError of this.apexSortedByType["parseError"]) {
              if (parseError["name"] === packageClass) {
                console.log(`Skipping coverage validation for ${packageClass}, unable to determine identity of class`);
                return false;
              }
            }
          }

          return true;
        });
      }

      if (this.apexSortedByType["interface"].length > 0) {
        // Filter out interfaces
        packageClasses = packageClasses.filter( (packageClass) => {
          for (let interfaceClass of this.apexSortedByType["interface"]) {
            if (interfaceClass["name"] === packageClass) {
              return false;
            }
          }
          return true;
        });
      }
    }

    return packageClasses;
  }

  private printClassesWithInvalidCoverage(classesWithInvalidCoverage: {name: string, coveredPercent: number}[]) {
    let table = new Table({
      head: ["Class", "Coverage Percent"],
    });

    classesWithInvalidCoverage.forEach( (classWithInvalidCoverage) => {
      table.push([classWithInvalidCoverage.name, classWithInvalidCoverage.coveredPercent]);
    })
    console.log(`The following classes do not satisfy the ${this.test_options["coverageThreshold"]}% code coverage requirement:`);
    console.log(table.toString());
  }
}
