// Crop requirements come from the seed handbook; soil readings come from
// the aimed farmland's HUD. Missing or unfamiliar text stays unknown.
export const FARM_SOIL = ['game:soil-medium-', 'game:soil-high-', 'game:soil-compost-'];

export function cropRequirements(page) {
  if (page?.class !== 'ItemPlantableSeed' || !Array.isArray(page.text)) return null;
  const text = page.text.join('\n').replace(/<[^>]*>/g, '');
  const nutrient = text.match(/Required Nutrient:\s*([NPK])\b/)?.[1];
  const number = pattern => {
    const value = text.match(pattern)?.[1];
    return value === undefined ? null : Number(value);
  };
  const consumption = number(/Nutrient Consumption:\s*([\d.]+)/);
  const days = number(/Growth Time:\s*([\d.]+)\s*days/);
  const cold = number(/Cold resistant until\s*(-?[\d.]+)\s*°C/);
  const heat = number(/Heat resistant until\s*(-?[\d.]+)\s*°C/);
  const crop = text.match(/\[(game:crop-[a-z]+-1)\]/)?.[1];
  return nutrient && crop && [consumption, days, cold, heat].every(v => v !== null && Number.isFinite(v))
    ? { nutrient, consumption, days, cold, heat, crop }
    : null;
}

export function farmlandReadings(info) {
  if (typeof info !== 'string') return null;
  const text = info.replace(/<[^>]*>/g, '');
  const nutrients = text.match(/Nutrient Levels:\s*([\d.]+)% N,\s*([\d.]+)% P,\s*([\d.]+)% K/);
  const moisture = text.match(/Moisture:\s*([\d.]+)%/);
  return nutrients && moisture
    ? { nutrients: { N: Number(nutrients[1]), P: Number(nutrients[2]), K: Number(nutrients[3]) }, moisture: Number(moisture[1]) }
    : null;
}

export function plantingProblem(crop, environment, soil) {
  if (!crop) return 'unknown_crop_requirements';
  const temperature = environment?.climate?.temperatureC;
  if (!Number.isFinite(temperature)) return 'unknown_temperature';
  if (temperature <= 0 || temperature < crop.cold || temperature > crop.heat) return 'unsuitable_temperature';
  if (!soil) return 'unknown_farmland';
  if (soil.moisture < 25) return 'dry_farmland';
  if (soil.nutrients[crop.nutrient] < crop.consumption) return 'depleted_nutrient';
  return null;
}
