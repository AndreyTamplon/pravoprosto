import { describe, expect, it } from 'vitest';
import {
  graphFromBackendFormat,
  graphToBackendFormat,
  optionEdgeCondition,
  reorderGraphNodes,
  verdictEdgeCondition,
  type LessonGraph,
} from './types';

describe('lesson graph helpers', () => {
  it('preserves multi-verdict single-choice options from backend graph', () => {
    const graph = graphFromBackendFormat({
      startNodeId: 'q1',
      nodes: [
        {
          id: 'q1',
          kind: 'single_choice',
          prompt: 'Question',
          options: [
            { id: 'a', text: 'A', result: 'correct', feedback: 'A ok', nextNodeId: 'end' },
            { id: 'b', text: 'B', result: 'correct', feedback: 'B ok', nextNodeId: 'end' },
            { id: 'c', text: 'C', result: 'partial', feedback: 'C almost', nextNodeId: 'end' },
            { id: 'd', text: 'D', result: 'incorrect', feedback: 'D bad', nextNodeId: 'end' },
          ],
        },
        { id: 'end', kind: 'end', text: 'Done' },
      ],
    });

    const question = graph.nodes[0];
    const options = (question.data.options as Array<Record<string, unknown>>);
    expect(options.map(option => option.verdict)).toEqual(['correct', 'correct', 'partial', 'incorrect']);
    expect(options.map(option => option.feedback)).toEqual(['A ok', 'B ok', 'C almost', 'D bad']);
  });

  it('writes canonical free-text rubric with verdict criteria and feedback', () => {
    const graph: LessonGraph = {
      startNodeId: 'free',
      nodes: [
        {
          id: 'free',
          type: 'free_text',
          data: {
            question_text: 'Why?',
            reference_answer: 'Because',
            criteria_correct: 'Mentions the core reason',
            criteria_partial: 'Mentions part of the reason',
            criteria_incorrect: 'Misses the core reason',
            feedback_correct: 'Correct feedback',
            feedback_partial: 'Partial feedback',
            feedback_incorrect: 'Incorrect feedback',
          },
        },
        { id: 'ok', type: 'story', data: { text: 'ok' } },
        { id: 'almost', type: 'story', data: { text: 'almost' } },
        { id: 'bad', type: 'story', data: { text: 'bad' } },
      ],
      edges: [
        { from: 'free', to: 'ok', condition: verdictEdgeCondition('correct') },
        { from: 'free', to: 'almost', condition: verdictEdgeCondition('partial') },
        { from: 'free', to: 'bad', condition: verdictEdgeCondition('incorrect') },
      ],
    };

    const backend = graphToBackendFormat(graph);
    const freeNode = ((backend.nodes as Array<Record<string, unknown>>).find(node => node.id === 'free'))!;
    expect(freeNode.rubric).toEqual({
      referenceAnswer: 'Because',
      criteriaByVerdict: {
        correct: 'Mentions the core reason',
        partial: 'Mentions part of the reason',
        incorrect: 'Misses the core reason',
      },
      feedbackByVerdict: {
        correct: 'Correct feedback',
        partial: 'Partial feedback',
        incorrect: 'Incorrect feedback',
      },
    });
  });

  it('upgrades legacy free-text rubric into editor fields', () => {
    const graph = graphFromBackendFormat({
      startNodeId: 'free',
      nodes: [
        {
          id: 'free',
          kind: 'free_text',
          prompt: 'Why?',
          rubric: {
            referenceAnswer: 'Because',
            criteria: 'Legacy criteria',
          },
          transitions: [
            { onVerdict: 'correct', nextNodeId: 'ok' },
            { onVerdict: 'partial', nextNodeId: 'ok' },
            { onVerdict: 'incorrect', nextNodeId: 'ok' },
          ],
        },
        { id: 'ok', kind: 'end', text: 'Done' },
      ],
    });

    const freeNode = graph.nodes[0];
    expect(freeNode.data.criteria_correct).toBe('Legacy criteria');
    expect(freeNode.data.criteria_partial).toBe('Legacy criteria');
    expect(freeNode.data.criteria_incorrect).toBe('Legacy criteria');
  });

  it('roundtrips decision nodes', () => {
    const graph: LessonGraph = {
      startNodeId: 'd1',
      nodes: [
        {
          id: 'd1',
          type: 'decision',
          data: {
            question_text: 'Choose',
            options: [
              { option_id: 'a', text: 'A' },
              { option_id: 'b', text: 'B' },
            ],
          },
        },
        { id: 'a_story', type: 'story', data: { text: 'A path' } },
        { id: 'b_story', type: 'story', data: { text: 'B path' } },
      ],
      edges: [
        { from: 'd1', to: 'a_story', condition: optionEdgeCondition('a') },
        { from: 'd1', to: 'b_story', condition: optionEdgeCondition('b') },
      ],
    };

    const backend = graphToBackendFormat(graph);
    const roundtrip = graphFromBackendFormat(backend);
    expect(roundtrip.nodes[0].type).toBe('decision');
    expect(roundtrip.edges).toEqual(graph.edges);
  });

  it('clears edges that become backward after reorder', () => {
    const graph: LessonGraph = {
      startNodeId: 'story',
      nodes: [
        { id: 'story', type: 'story', data: { text: 'Story' } },
        { id: 'decision', type: 'decision', data: { question_text: 'Choose', options: [{ option_id: 'a', text: 'A' }, { option_id: 'b', text: 'B' }] } },
        { id: 'branch_a', type: 'story', data: { text: 'A' } },
        { id: 'branch_b', type: 'story', data: { text: 'B' } },
      ],
      edges: [
        { from: 'story', to: 'decision' },
        { from: 'decision', to: 'branch_a', condition: optionEdgeCondition('a') },
        { from: 'decision', to: 'branch_b', condition: optionEdgeCondition('b') },
      ],
    };

    const { graph: reordered, clearedEdges } = reorderGraphNodes(graph, 3, 1);
    expect(clearedEdges).toBe(1);
    expect(reordered.edges).toEqual([
      { from: 'story', to: 'decision' },
      { from: 'decision', to: 'branch_a', condition: optionEdgeCondition('a') },
    ]);
  });
});
