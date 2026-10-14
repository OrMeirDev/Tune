// The problems a user can pick, with their icons (the diagnosis page and the overview's shortcuts).
import { Gamepad2, Thermometer, Timer } from 'lucide-react';
import { PROBLEMS } from '../../domain/diagnosis.mjs';

const ICONS = { slowBoot: Timer, gameStutter: Gamepad2, overheating: Thermometer };

export const PROBLEM_LIST = PROBLEMS.map((id) => ({ id, icon: ICONS[id] }));
