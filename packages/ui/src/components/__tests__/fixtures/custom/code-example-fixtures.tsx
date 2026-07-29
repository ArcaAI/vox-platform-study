import { CodeExample } from '../../../custom/code-example';

const sampleCode = `const greeting = "Hello, world!"
console.log(greeting)`;

export function CollapsedCodeExample() {
  return <CodeExample title="Sample Code" code={sampleCode} language="typescript" />;
}

export function ExpandedCodeExample() {
  return <CodeExample title="Sample Code" code={sampleCode} language="typescript" defaultOpen />;
}

export function PythonCodeExample() {
  return <CodeExample title="Python Example" code={'print("Hello from Python")'} language="python" defaultOpen />;
}
