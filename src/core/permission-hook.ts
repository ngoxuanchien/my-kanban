import type { RuntimeTaskHookActivity } from "./api-contract";

export function isPermissionRequestHook(
	metadata: { hookEventName?: string | null; notificationType?: string | null } | null | undefined,
): boolean {
	return (
		metadata?.hookEventName?.toLowerCase() === "permissionrequest" ||
		metadata?.notificationType === "permission_prompt" ||
		metadata?.notificationType === "permission.asked"
	);
}

export function isPermissionWaitActivity(activity: RuntimeTaskHookActivity | null | undefined): boolean {
	return activity?.activityText === "Waiting for approval";
}
