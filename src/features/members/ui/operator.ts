import { queryOptions } from '@tanstack/react-query';
import { members } from './rpc.ts';

/**
 * Whether the signed-in member is the operator, which decides whether the Members page shows at
 * all. It's asked once a session: the operator is the deployment's to name, not the page's.
 */
export const operatorQuery = queryOptions({
  queryKey: ['operator'],
  queryFn: () => members.isOperator(),
});
