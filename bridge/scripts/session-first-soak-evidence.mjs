export function catalogFingerprint(models = []) {
  return models
    .map((model) => `${model.providerID ?? ""}/${model.modelID ?? ""}/${model.variantConfigId ?? ""}/${model.variant ?? ""}`)
    .sort()
    .join("|")
}

export function modelCatalogKey(model = {}) {
  return `${model.providerID ?? ""}/${model.modelID ?? ""}`
}

function baseModel(candidates = []) {
  return candidates.find((model) => !model.variant && !model.variantConfigId) ?? candidates[0]
}

export function selectSoakModels(models = [], requestedSelectors = [], count = 3) {
  const uniqueKeys = []
  const byKey = new Map()
  for (const model of models) {
    const key = modelCatalogKey(model)
    if (!byKey.has(key)) {
      uniqueKeys.push(key)
      byKey.set(key, [])
    }
    byKey.get(key).push(model)
  }

  if (requestedSelectors.length === 0) {
    return {
      models: uniqueKeys.slice(0, count).map((key) => baseModel(byKey.get(key))),
      unresolved: [],
      explicit: false
    }
  }

  const selectors = [...new Set(requestedSelectors.map((selector) => String(selector).trim()).filter(Boolean))]
  const selected = []
  const selectedKeys = new Set()
  const unresolved = []

  for (const selector of selectors) {
    const modelIDKeys = uniqueKeys.filter((key) => byKey.get(key)?.[0]?.modelID === selector)
    const exactKeys = byKey.has(selector) ? [selector] : []
    const matches = modelIDKeys.length > 0 ? modelIDKeys : exactKeys
    if (matches.length !== 1) {
      unresolved.push({ selector, reason: matches.length > 1 ? "ambiguous" : "missing" })
      continue
    }
    const key = matches[0]
    if (selectedKeys.has(key)) continue
    selectedKeys.add(key)
    selected.push(baseModel(byKey.get(key)))
  }

  return { models: selected, unresolved, explicit: true }
}

export function catalogOwnershipEvidence({ primary, secondary, primaryModels = [], secondaryModels = [], state = {} }) {
  const primaryState = state.agents?.[primary]
  const secondaryState = state.agents?.[secondary]
  const primaryFingerprint = catalogFingerprint(primaryModels)
  const secondaryFingerprint = catalogFingerprint(secondaryModels)

  return {
    primaryFingerprint,
    secondaryFingerprint,
    catalogsIdentical: primaryFingerprint === secondaryFingerprint,
    checks: [
      { ok: primaryModels.length > 0, message: `${primary} advertises a model catalog` },
      { ok: secondaryModels.length > 0, message: `${secondary} advertises a model catalog` },
      { ok: Boolean(primaryState), message: `${primary}: diagnostics expose its registered agent entry` },
      { ok: Boolean(secondaryState), message: `${secondary}: diagnostics expose its registered agent entry` },
      {
        ok: (primaryState?.catalogModels ?? 0) > 0,
        message: `${primary}: diagnostics own a populated model catalog (${primaryState?.catalogModels ?? 0})`
      },
      {
        ok: (secondaryState?.catalogModels ?? 0) > 0,
        message: `${secondary}: diagnostics own a populated model catalog (${secondaryState?.catalogModels ?? 0})`
      },
      {
        ok: Boolean(primaryState?.catalogSource),
        message: `${primary}: diagnostics identify the catalog source (${primaryState?.catalogSource ?? "missing"})`
      },
      {
        ok: Boolean(secondaryState?.catalogSource),
        message: `${secondary}: diagnostics identify the catalog source (${secondaryState?.catalogSource ?? "missing"})`
      }
    ]
  }
}
