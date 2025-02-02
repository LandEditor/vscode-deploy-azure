import * as os from "os";
import * as Path from "path";
import * as utils from "util";
import * as fse from "fs-extra";
import * as vscode from "vscode";
import { UserCancelledError } from "vscode-azureextensionui";

import { ArmRestClient } from "../clients/azure/armRestClient";
import { IProvisioningServiceClient } from "../clients/IProvisioningServiceClient";
import { ProvisioningServiceClientFactory } from "../clients/provisioningServiceClientFactory";
import { sleepForMilliSeconds } from "../helper/commonHelper";
import { ControlProvider } from "../helper/controlProvider";
import { GraphHelper } from "../helper/graphHelper";
import { LocalGitRepoHelper } from "../helper/LocalGitRepoHelper";
import { telemetryHelper } from "../helper/telemetryHelper";
import { ExtendedInputDescriptor, InputDataType } from "../model/Contracts";
import { WizardInputs } from "../model/models";
import {
	CompletePipelineConfiguration,
	DraftPipelineConfiguration,
	File,
	ProvisioningConfiguration,
} from "../model/provisioningConfiguration";
import { RemotePipelineTemplate } from "../model/templateModels";
import { Messages } from "../resources/messages";
import { TelemetryKeys } from "../resources/telemetryKeys";
import { TracePoints } from "../resources/tracePoints";
import { InputControl } from "../templateInputHelper/InputControl";
import { IProvisioningConfigurer } from "./IProvisioningConfigurer";

// tslint:disable-next-line:interface-name
interface DraftFile {
	content: string;

	path: string; // This path will be one returned by provisioning service and it will based on linux
	absPath: string; // This is absolute path of file for native OS
}

const Layer: string = "ProvisioningConfigurer";

export class ProvisioningConfigurer implements IProvisioningConfigurer {
	private provisioningServiceClient: IProvisioningServiceClient;

	private queuedPipelineUrl: string;

	private refreshTime: number = 5 * 1000;

	private maxNonStatusRetry: number = 60; // retries for max 5 min
	private localGitRepoHelper: LocalGitRepoHelper;

	private filesToCommit: DraftFile[] = [];

	private committedWorkflow: string;

	private tempWorkflowDirPath: string;

	constructor(localGitRepoHelper: LocalGitRepoHelper) {
		this.localGitRepoHelper = localGitRepoHelper;
	}

	public async queueProvisioningPipelineJob(
		provisioningConfiguration: ProvisioningConfiguration,
		wizardInputs: WizardInputs,
	): Promise<ProvisioningConfiguration> {
		try {
			this.provisioningServiceClient =
				await ProvisioningServiceClientFactory.getClient();

			const OrgAndRepoDetails =
				wizardInputs.sourceRepository.repositoryId.split("/");

			return await this.provisioningServiceClient.createProvisioningConfiguration(
				provisioningConfiguration,
				OrgAndRepoDetails[0],
				OrgAndRepoDetails[1],
			);
		} catch (error) {
			telemetryHelper.logError(
				Layer,
				TracePoints.UnableToCreateProvisioningPipeline,
				error,
			);

			throw error;
		}
	}

	public async getProvisioningPipeline(
		jobId: string,
		githubOrg: string,
		repository: string,
		wizardInputs: WizardInputs,
	): Promise<ProvisioningConfiguration> {
		try {
			this.provisioningServiceClient =
				await ProvisioningServiceClientFactory.getClient();

			return await this.provisioningServiceClient.getProvisioningConfiguration(
				jobId,
				githubOrg,
				repository,
			);
		} catch (error) {
			telemetryHelper.logError(
				Layer,
				TracePoints.UnabletoGetProvisioningPipeline,
				error,
			);

			throw error;
		}
	}

	public async awaitProvisioningPipelineJob(
		jobId: string,
		githubOrg: string,
		repository: string,
		wizardInputs: WizardInputs,
	): Promise<ProvisioningConfiguration> {
		let statusNotFound: number = 0;

		const provisioningServiceResponse = await this.getProvisioningPipeline(
			jobId,
			githubOrg,
			repository,
			wizardInputs,
		);

		if (provisioningServiceResponse && provisioningServiceResponse.result) {
			if (
				provisioningServiceResponse.result.status === "Queued" ||
				provisioningServiceResponse.result.status == "InProgress"
			) {
				await sleepForMilliSeconds(this.refreshTime);

				return await this.awaitProvisioningPipelineJob(
					jobId,
					githubOrg,
					repository,
					wizardInputs,
				);
			} else if (provisioningServiceResponse.result.status === "Failed") {
				throw new Error(provisioningServiceResponse.result.message);
			} else {
				return provisioningServiceResponse;
			}
		} else {
			if (statusNotFound < this.maxNonStatusRetry) {
				statusNotFound++;

				await sleepForMilliSeconds(this.refreshTime);

				return await this.awaitProvisioningPipelineJob(
					jobId,
					githubOrg,
					repository,
					wizardInputs,
				);
			} else {
				throw new Error(
					"Failed to receive queued pipeline provisioning job status",
				);
			}
		}
	}

	public async browseQueuedWorkflow(): Promise<void> {
		let displayMessage: string;

		if (this.committedWorkflow.length > 1) {
			displayMessage = Messages.GithubWorkflowSetupMultiFile;
		} else {
			displayMessage = Messages.GithubWorkflowSetup;
		}

		new ControlProvider()
			.showInformationBox(
				"Browse queued workflow",
				utils.format(displayMessage, this.committedWorkflow),
				Messages.browseWorkflow,
			)
			.then((action: string) => {
				if (
					action &&
					action.toLowerCase() ===
						Messages.browseWorkflow.toLowerCase()
				) {
					telemetryHelper.setTelemetry(
						TelemetryKeys.BrowsePipelineClicked,
						"true",
					);

					vscode.env.openExternal(
						vscode.Uri.parse(this.queuedPipelineUrl),
					);
				}
			});
	}

	public async postSteps(
		provisioningConfiguration: ProvisioningConfiguration,
		draftPipelineConfiguration: DraftPipelineConfiguration,
		inputs: WizardInputs,
	): Promise<void> {
		await this.populateFilesToCommit(draftPipelineConfiguration);

		await this.showPipelineFiles();

		const displayMessage =
			this.filesToCommit.length > 1
				? Messages.modifyAndCommitMultipleFiles
				: Messages.modifyAndCommitFile;

		const commitOrDiscard = await new ControlProvider().showInformationBox(
			"Commit or discard",
			utils.format(
				displayMessage,
				Messages.commitAndPush,
				inputs.sourceRepository.branch,
				inputs.sourceRepository.remoteName,
			),
			Messages.commitAndPush,
			Messages.discardPipeline,
		);

		let provisioningServiceResponse: ProvisioningConfiguration;

		if (
			!!commitOrDiscard &&
			commitOrDiscard.toLowerCase() ===
				Messages.commitAndPush.toLowerCase()
		) {
			telemetryHelper.setCurrentStep(
				"ConfiguringPreRequisiteParamsForCompleteMode",
			);

			if (this.getInputDescriptor(inputs, "azureAuth")) {
				await this.createSPN(inputs);
			}

			provisioningServiceResponse = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: Messages.ConfiguringGithubWorkflowAndDeployment,
				},
				async () => {
					try {
						telemetryHelper.setCurrentStep(
							"QueuedCompleteProvisioiningPipeline",
						);

						provisioningConfiguration.pipelineConfiguration =
							await this.createFilesToCheckin(
								draftPipelineConfiguration.id,
								draftPipelineConfiguration.type,
							);

						const completeProvisioningSvcResp =
							await this.queueProvisioningPipelineJob(
								provisioningConfiguration,
								inputs,
							);

						if (completeProvisioningSvcResp.id != "") {
							const OrgAndRepoDetails =
								inputs.sourceRepository.repositoryId.split("/");

							telemetryHelper.setCurrentStep(
								"AwaitCompleteProvisioningPipeline",
							);

							return await this.awaitProvisioningPipelineJob(
								completeProvisioningSvcResp.id,
								OrgAndRepoDetails[0],
								OrgAndRepoDetails[1],
								inputs,
							);
						} else {
							throw new Error("Failed to configure pipeline");
						}
					} catch (error) {
						telemetryHelper.logError(
							Layer,
							TracePoints.RemotePipelineConfiguringFailed,
							error,
						);

						vscode.window.showErrorMessage(
							utils.format(
								Messages.ConfiguringGitubWorkflowFailed,
								error.message,
							),
						);

						return null;
					}
				},
			);
		} else {
			telemetryHelper.setTelemetry(
				TelemetryKeys.PipelineDiscarded,
				"true",
			);

			await this.moveWorkflowFilesToLocalRepo();

			throw new UserCancelledError(Messages.operationCancelled);
		}

		fse.removeSync(this.tempWorkflowDirPath);

		if (provisioningServiceResponse != undefined) {
			this.setQueuedPipelineUrl(provisioningServiceResponse, inputs);
		} else {
			throw new Error("Failed to configure provisoining pipeline");
		}
	}

	public async preSteps(
		provisioningConfiguration: ProvisioningConfiguration,
		inputs: WizardInputs,
	): Promise<ProvisioningConfiguration> {
		return await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: Messages.GeneratingWorkflowFiles,
			},
			async () => {
				try {
					telemetryHelper.setCurrentStep(
						"QueuedDraftProvisioningPipeline",
					);
					// Initially send the provisioning request in draft mode to get workflow files
					const provisioningServiceDraftModeResponse: ProvisioningConfiguration =
						await this.queueProvisioningPipelineJob(
							provisioningConfiguration,
							inputs,
						);

					if (provisioningServiceDraftModeResponse.id != "") {
						// Monitor the provisioning pipeline
						telemetryHelper.setCurrentStep(
							"AwaitDraftProvisioningPipeline",
						);

						const OrgAndRepoDetails =
							inputs.sourceRepository.repositoryId.split("/");

						return await this.awaitProvisioningPipelineJob(
							provisioningServiceDraftModeResponse.id,
							OrgAndRepoDetails[0],
							OrgAndRepoDetails[1],
							inputs,
						);
					} else {
						throw new Error(
							"Failed to configure provisioning pipeline",
						);
					}
				} catch (error) {
					telemetryHelper.logError(
						Layer,
						TracePoints.ConfiguringDraftPipelineFailed,
						error,
					);

					throw error;
				}
			},
		);
	}

	public async showPipelineFiles(): Promise<void> {
		this.filesToCommit.forEach(async (file) => {
			await this.localGitRepoHelper.writeFileContent(
				file.content,
				file.absPath,
			);

			await vscode.window.showTextDocument(
				vscode.Uri.file(file.absPath),
				{ preview: false },
			);
		});
	}

	public setQueuedPipelineUrl(
		provisioningConfiguration: ProvisioningConfiguration,
		inputs: WizardInputs,
	) {
		const commitId = (
			provisioningConfiguration.result
				.pipelineConfiguration as CompletePipelineConfiguration
		).commitId;

		this.queuedPipelineUrl = `https://github.com/${inputs.sourceRepository.repositoryId}/commit/${commitId}/checks`;

		this.committedWorkflow = `https://github.com/${inputs.sourceRepository.repositoryId}/commit/${commitId}`;
	}

	public async populateFilesToCommit(
		draftPipelineConfiguration: DraftPipelineConfiguration,
	): Promise<void> {
		let destination: string;

		this.tempWorkflowDirPath = fse.mkdtempSync(
			os.tmpdir().concat(Path.sep),
		);

		for (const file of draftPipelineConfiguration.files) {
			const pathList = file.path.split("/");

			const filePath: string = pathList.join(Path.sep);

			destination = await this.getPathToFile(
				Path.basename(filePath),
				Path.dirname(filePath),
			);

			const decodedData = new Buffer(file.content, "base64").toString(
				"utf-8",
			);

			this.filesToCommit.push({
				absPath: destination,
				content: decodedData,
				path: file.path,
			} as DraftFile);
		}
	}

	public async createPreRequisiteParams(
		wizardInputs: WizardInputs,
	): Promise<void> {
		// Create armAuthToken
		wizardInputs.pipelineConfiguration.params["armAuthToken"] =
			"Bearer " +
			(await GraphHelper.getAccessToken(wizardInputs.azureSession));
	}

	public async createSPN(wizardInputs: WizardInputs): Promise<void> {
		// Create SPN and ACRResource group for reuseACR flow set to false
		const inputDescriptor = this.getInputDescriptor(
			wizardInputs,
			"azureAuth",
		);

		const createResourceGroup = InputControl.getInputDescriptorProperty(
			inputDescriptor,
			"resourceGroup",
			wizardInputs.pipelineConfiguration.params,
		);

		const location = InputControl.getInputDescriptorProperty(
			inputDescriptor,
			"location",
			wizardInputs.pipelineConfiguration.params,
		);

		if (
			createResourceGroup &&
			createResourceGroup.length > 0 &&
			createResourceGroup[0] != "" &&
			location &&
			location.length > 0 &&
			location[0] != ""
		) {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: Messages.CreatingResourceGroup,
				},
				async () => {
					try {
						// TODO: Add support for multiple resource group
						return await new ArmRestClient(
							wizardInputs.azureSession,
						).createResourceGroup(
							wizardInputs.subscriptionId,
							createResourceGroup[0],
							location[0],
						);
					} catch (error) {
						telemetryHelper.logError(
							Layer,
							TracePoints.ResourceGroupCreationFailed,
							error,
						);

						throw error;
					}
				},
			);
		}

		const scope = InputControl.getInputDescriptorProperty(
			inputDescriptor,
			"scope",
			wizardInputs.pipelineConfiguration.params,
		);

		if (scope && scope.length > 0 && scope[0] != "") {
			wizardInputs.pipelineConfiguration.params["azureAuth"] =
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: Messages.CreatingSPN,
					},
					async () => {
						try {
							// TODO: Need to add support for array of scope
							return await this.getAzureSPNSecret(
								wizardInputs,
								scope[0],
							);
						} catch (error) {
							telemetryHelper.logError(
								Layer,
								TracePoints.SPNCreationFailed,
								error,
							);

							throw error;
						}
					},
				);
		}
	}

	private getInputDescriptor(
		wizardInputs: WizardInputs,
		inputId: string,
	): ExtendedInputDescriptor {
		const template = wizardInputs.pipelineConfiguration
			.template as RemotePipelineTemplate;

		let inputDataType: InputDataType;

		switch (inputId) {
			case "azureAuth":
				inputDataType = InputDataType.Authorization;

				break;

			default:
				return undefined;
		}

		return template.parameters.inputs.find(
			(value) => value.type === inputDataType && value.id === inputId,
		);
	}

	private async getAzureSPNSecret(
		inputs: WizardInputs,
		scope?: string,
	): Promise<string> {
		const aadAppName = GraphHelper.generateAadApplicationName(
			inputs.sourceRepository.remoteName,
			"github",
		);

		const aadApp = await GraphHelper.createSpnAndAssignRole(
			inputs.azureSession,
			aadAppName,
			scope,
		);

		return JSON.stringify({
			scheme: "ServicePrincipal",
			parameters: {
				serviceprincipalid: `${aadApp.appId}`,
				serviceprincipalkey: `${aadApp.secret}`,
				subscriptionId: `${inputs.subscriptionId}`,
				tenantid: `${inputs.azureSession.tenantId}`,
			},
		});
	}

	// tslint:disable-next-line:no-reserved-keywords
	private async createFilesToCheckin(
		id: string,
		type: string,
	): Promise<DraftPipelineConfiguration> {
		const files: File[] = [];

		for (const file of this.filesToCommit) {
			const fileContent = await this.localGitRepoHelper.readFileContent(
				file.absPath,
			);

			const encodedContent = new Buffer(fileContent, "utf-8").toString(
				"base64",
			);

			files.push({ path: file.path, content: encodedContent });
		}

		return {
			id,
			type,
			files,
		} as DraftPipelineConfiguration;
	}

	private async moveWorkflowFilesToLocalRepo(): Promise<void> {
		const gitRootDirectory: string =
			await this.localGitRepoHelper.getGitRootDirectory();

		for (const file of this.filesToCommit) {
			const filePathList = file.path.split("/");

			const filePath: string = filePathList.join(Path.sep);

			const filePathToLocalRepo: string = Path.join(
				gitRootDirectory,
				filePath,
			);

			fse.moveSync(file.absPath, filePathToLocalRepo);

			await vscode.window.showTextDocument(
				vscode.Uri.file(filePathToLocalRepo),
				{ preview: false },
			);
		}

		fse.removeSync(this.tempWorkflowDirPath);
	}

	private async getPathToFile(fileName: string, directory: string) {
		const dirList = directory.split("/"); // Hardcoded as provisioning service is running on linux and we cannot use Path.sep as it is machine dependent
		const directoryPath: string = Path.join(
			this.tempWorkflowDirPath,
			dirList.join(Path.sep),
		);

		fse.mkdirpSync(directoryPath);

		telemetryHelper.setTelemetry(TelemetryKeys.WorkflowFileName, fileName);

		return Path.join(directoryPath, fileName);
	}
}
