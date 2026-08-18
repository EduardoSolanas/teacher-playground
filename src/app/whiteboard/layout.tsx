import { AccessSessionBootstrap } from "../../components/AccessSessionBootstrap";

export default function WhiteboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AccessSessionBootstrap>{children}</AccessSessionBootstrap>;
}
