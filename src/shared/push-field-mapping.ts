export const pushMappingIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_.]*$/

// Local identity/type fields must never be sent under their original keys.
// ItemID is allowed as a source only because the push contract explicitly
// remaps its value to the business field AcceptCriteria.
export const pushForbiddenSourceFields: ReadonlySet<string> = new Set([
  '_valm_Uid',
  '_valm_NodeType'
])

export const pushForbiddenTargetFields: ReadonlySet<string> = new Set([
  '_valm_Uid',
  '_valm_NodeType',
  '_valm_ItemID'
])

const pushDefaultTargetFields: Readonly<Record<string, string>> = {
  Source: 'RequireBy',
  _valm_Description: 'UserStoryDescription',
  _valm_ItemID: 'AcceptCriteria',
  RAO: 'Devs',
  TSIS_ClarifyInfo: '_valm_Description'
}

export const defaultPushTargetField = (sourceField: string): string => (
  pushDefaultTargetFields[sourceField] ?? sourceField
)
