import { ApiRequestError } from '../api/client';

export interface DraftValidationItem {
  path: string;
  code: string;
  message: string;
}

function translateValidationMessage(item: DraftValidationItem): string {
  switch (item.code) {
    case 'invalid_content':
      return 'Содержимое курса повреждено. Обновите страницу и попробуйте снова.';
    case 'invalid_module':
      return 'Один из модулей повреждён. Обновите страницу и попробуйте снова.';
    case 'missing_module_id':
      return 'У одного из модулей отсутствует идентификатор.';
    case 'duplicate_module_id':
      return 'Идентификаторы модулей должны быть уникальными.';
    case 'invalid_lesson':
      return 'Один из уроков повреждён. Обновите страницу и попробуйте снова.';
    case 'missing_lesson_id':
      return 'У одного из уроков отсутствует идентификатор.';
    case 'duplicate_lesson_id':
      return 'Идентификаторы уроков должны быть уникальными.';
    case 'missing_graph':
      return 'Урок должен содержать граф шагов.';
    case 'missing_start_node':
      return 'У графа урока не задан стартовый блок.';
    case 'missing_start_target':
      return 'Стартовый блок указывает на несуществующий узел.';
    case 'missing_options':
      return 'Добавьте варианты ответа для вопроса с выбором.';
    case 'missing_decision_options':
      return 'Для развилки сюжета нужно добавить минимум два варианта выбора.';
    case 'invalid_option':
      return 'У каждого варианта ответа должны быть заполнены результат, обратная связь и переход к следующему блоку.';
    case 'invalid_decision_option':
      return 'У каждого варианта сюжетного выбора должны быть текст и переход к следующему блоку.';
    case 'missing_correct_option':
      return 'У вопроса с выбором должен быть хотя бы один правильный вариант.';
    case 'missing_transition_target':
      return 'Один из блоков указывает на несуществующий следующий шаг.';
    case 'missing_transition':
      if (item.path.includes('transitions')) {
        return 'Заполните переход для каждого результата свободного ответа.';
      }
      if (item.path.includes('nextNodeId')) {
        return 'Укажите следующий блок для этого шага.';
      }
      return 'Для этого блока не хватает переходов.';
    case 'invalid_transition':
      return 'У перехода свободного ответа должны быть заполнены результат и следующий блок.';
    case 'missing_free_text_criteria':
      return 'Для свободного ответа нужно заполнить критерии для каждого вердикта.';
    case 'missing_free_text_feedback':
      return 'Для свободного ответа нужно заполнить обратную связь для каждого вердикта.';
    case 'unreachable_node':
      return 'В графе есть блок, до которого нельзя дойти из стартового.';
    case 'cycle_detected':
      return 'Граф урока не должен содержать циклы.';
    case 'invalid_node_kind':
      return 'В графе найден неподдерживаемый тип блока.';
    case 'missing_node_id':
      return 'У одного из блоков не задан идентификатор.';
    case 'duplicate_node_id':
      return 'Идентификаторы блоков должны быть уникальны.';
    default:
      return item.message;
  }
}

export function getDraftValidationErrors(err: unknown): DraftValidationItem[] {
  if (!(err instanceof ApiRequestError)) {
    return [];
  }
  const rawErrors = err.details?.errors;
  if (!Array.isArray(rawErrors)) {
    return [];
  }
  const seenMessages = new Set<string>();

  return rawErrors
    .map((raw): DraftValidationItem | null => {
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const item = raw as Record<string, unknown>;
      return {
        path: (item.path as string) ?? '',
        code: (item.code as string) ?? 'validation_error',
        message: translateValidationMessage({
          path: (item.path as string) ?? '',
          code: (item.code as string) ?? 'validation_error',
          message: (item.message as string) ?? 'Ошибка валидации',
        }),
      };
    })
    .filter((item): item is DraftValidationItem => item !== null)
    .filter((item) => {
      if (seenMessages.has(item.message)) {
        return false;
      }
      seenMessages.add(item.message);
      return true;
    });
}

export function hasDraftValidationErrors(err: unknown): boolean {
  return getDraftValidationErrors(err).length > 0;
}

export function parseOptionalInteger(label: string, rawValue: string): number | undefined {
  const value = rawValue.trim();
  if (value === '') {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Поле «${label}» должно быть целым числом.`);
  }
  return Number(value);
}

export function validateAgeRange(ageMin: number | undefined, ageMax: number | undefined) {
  if (ageMin !== undefined && ageMax !== undefined && ageMin > ageMax) {
    throw new Error('Возраст от не может быть больше возраста до.');
  }
}
