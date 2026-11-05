# IDaaS Customer Skills

[简体中文](README_zh.md)

Agent Skills for IDaaS users: connect local cloud CLIs and migrate application code from long-term AccessKeys to IDaaS short-lived credentials.

## Choose a skill

| Skill | Use case | Main inputs |
|---|---|---|
| [idaas-cred-init](idaas-cred-init/SKILL.md) | Connect local aliyun-cli, aws-cli or tccli; discover roles; refresh login or log out | Instance domain, target CLI, optional client application |
| [idaas-java-akless-onboard](idaas-java-akless-onboard/SKILL.md) | Migrate Java OSS, SLS and generic OpenAPI clients away from static AccessKeys | Application repository, platform configuration, role ARN, deployment identity for runtime validation |
| [idaas-go-akless-onboard](idaas-go-akless-onboard/SKILL.md) | Migrate Go OSS, SLS and generic OpenAPI clients away from static AccessKeys | Application repository, platform configuration, role ARN, deployment identity for runtime validation |
| [idaas-python-akless-onboard](idaas-python-akless-onboard/SKILL.md) | Migrate Python OSS, SLS and generic OpenAPI clients away from static AccessKeys | Python 3.9+, application repository, platform configuration, role ARN |

Use `idaas-cred-init` for interactive access from a developer's computer. For application code migration, prepare its platform configuration and deployment identity, then use the corresponding language skill.

## Prerequisites

- An agent that can load Skills and run the tools required by the selected skill.
- The intended IDaaS instance and environment, with network access to the required services.
- Permissions for the requested operation. Platform configuration, application access and cloud resource access are separate permissions; check the selected skill's requirements.
- Any required local CLI, runtime, source repository or workload environment. There is no single dependency set shared by all skills.

Each skill's `SKILL.md` is its execution entry point and defines its specific inputs, dependencies, authorization boundaries and verification steps. Installing a skill does not itself install external tools, grant permissions or establish cloud-side trust.

## Install and use

Copy the entire selected skill directory into your agent's supported skills directory, preserving its resources. For example, from this repository root, when the destination does not already exist:

```sh
mkdir -p /path/to/agent/skills
cp -R idaas-cred-init /path/to/agent/skills/
```

Replace `/path/to/agent/skills` with your agent's actual directory. Install individual skill directories rather than the repository root. Back up an existing installation before replacing it, then reload skills or start a new session as required by your agent.

Example requests:

- "Use idaas-cred-init to connect my local Alibaba Cloud CLI to my IDaaS instance."
- "Use idaas-cred-init to show the cloud roles available to me in this instance."
- "Use idaas-java-akless-onboard to migrate this Java project's static AccessKey authentication to IDaaS short-lived credentials."

Provide the target environment and resource identifiers, and state which changes you want. Complete interactive login and MFA yourself; do not paste passwords or credentials into the conversation.

## Dependencies and configuration

This repository contains skill instructions and supporting resources. External CLIs, SDKs and IDaaS services have their own releases and capabilities. Updating a skill does not automatically upgrade those dependencies.

Check tool versions, configuration locations and compatibility requirements in the selected skill and its references. A locally built tool can be used when its source and required capabilities have been verified; provide its executable path explicitly. Review configuration changes and preserve existing profiles or defaults unless you intend to replace them.

## Verification and safety

Keep document validation, offline checks, test-environment integration and real credential or cloud API validation separate in reports. Configuration generation alone does not prove that authentication or resource access works. Mark unexecuted checks clearly and verify the intended account, instance and role before drawing a conclusion.

Do not include passwords, AccessKey secrets, client secrets, tokens, STS credentials or credential caches in this repository, logs, screenshots or test artifacts. Tools may maintain their own credential storage; follow the selected skill's handling rules. Keep platform and cloud permissions scoped to the task.

Record resources created for testing and clean them up when authorized. Check the cleanup scope carefully: removing platform configuration does not necessarily remove corresponding cloud resources, and logging out does not necessarily delete profiles.

## Repository layout and maintenance

Each skill is maintained independently:

- `SKILL.md`: discovery metadata and execution workflow.
- `references/`: detailed guidance loaded as needed.
- `scripts/`: executable helpers, where needed.
- `assets/`: templates or other resources, where needed.

Keep the repository README focused on the skill catalog and shared usage guidance. Put dependency-specific capabilities, API contracts, compatibility details and troubleshooting in the relevant skill or dependency documentation.

When changing a skill, check its referenced files, commands and examples together. Run appropriate checks for changed scripts and distinguish local validation from external integration results. The repository README defaults to English; maintain its Chinese counterpart in `README_zh.md` and keep their scope and meaning aligned.
