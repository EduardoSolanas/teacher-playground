import { AccessSessionBootstrap } from "../../components/AccessSessionBootstrap";
import BoardEditorPreload from "../../components/BoardEditorPreload";

export default function WhiteboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <BoardEditorPreload />
      <AccessSessionBootstrap>{children}</AccessSessionBootstrap>
    </>
  );
}
